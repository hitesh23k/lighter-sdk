import { Logger } from "../logger";
import LighterConstant from "../constants";
import {
    LighterWsConfig,
    LighterWsMessage,
    LighterWsEvent,
    LighterWsHandler,
    LighterChannelHandler,
    WebSocketCtor,
    WebSocketLike,
    Unsubscribe,
} from "./types";

// WebSocket.readyState OPEN is 1 in both the browser and the `ws` package.
const WS_OPEN = 1;

/** Resolve a WebSocket constructor: caller-injected → global (browser / Node >= 22) → optional `ws` package. */
async function resolveWebSocketCtor(inject?: WebSocketCtor): Promise<WebSocketCtor> {
    if (inject) return inject;
    const g = globalThis as any;
    if (typeof g.WebSocket !== "undefined") return g.WebSocket as WebSocketCtor;
    try {
        // Indirect specifier so this stays a runtime-only optional dependency (not statically resolved by
        // the type checker or bundled). `ws` is declared under optionalDependencies.
        const wsModuleName = "ws";
        const mod: any = await import(wsModuleName);
        return (mod.default ?? mod.WebSocket) as WebSocketCtor;
    } catch {
        throw new Error(
            "LighterWs::No WebSocket implementation available. On Node < 22, install the optional `ws` " +
                "package or pass { WebSocketImpl } in the config.",
        );
    }
}

/**
 * WebSocket client for Lighter's streaming API. Handles connection lifecycle, keepalive (server closes
 * idle sockets after 2 minutes), automatic reconnect with exponential backoff, and re-subscription of all
 * active channels after a reconnect. Works in the browser (global `WebSocket`) and Node (the `ws` package
 * or global `WebSocket` on Node >= 22).
 *
 * Dispatch: every inbound frame goes to `on("message", …)` listeners; channel frames additionally go to the
 * handlers registered for their channel. Channel matching normalizes `:`/`/` separators so it is robust to
 * the server echoing `order_book:1` vs `order_book/1`.
 */
export default class LighterWs {
    private readonly url: string;
    private readonly keepAliveMs: number;
    private readonly autoReconnect: boolean;
    private readonly reconnectBaseMs: number;
    private readonly reconnectMaxMs: number;
    private readonly wsCtorInject?: WebSocketCtor;

    private readonly getAuthToken?: () => string | Promise<string>;

    private ws: WebSocketLike | null = null;
    private wsCtor: WebSocketCtor | null = null;
    private closedByUser = false;
    /** True once a socket has opened at least once — gates auto-reconnect so a failed initial connect stays dead. */
    private everConnected = false;
    private reconnectAttempts = 0;
    private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    /** Channels the caller wants subscribed; resent on every (re)connect. */
    private desiredChannels: Set<string> = new Set();
    /** Per-channel handlers, keyed by normalized channel string. */
    private channelHandlers: Map<string, Set<LighterChannelHandler>> = new Map();
    /** Lifecycle/message listeners. */
    private listeners: Map<LighterWsEvent, Set<LighterWsHandler>> = new Map();

    constructor(config: LighterWsConfig = {}) {
        const isMainnet = config.isMainnet !== false;
        if (config.url) {
            this.url = config.url;
        } else {
            const venue = config.venue || LighterConstant.VENUE.ZK;
            const { baseUrl } = LighterConstant.resolveVenue(venue, isMainnet);
            const wssBase = baseUrl.replace(/^http/i, "ws"); // https -> wss, http -> ws
            this.url = `${wssBase}/stream${config.readonly ? "?readonly=true" : ""}`;
        }
        this.keepAliveMs = config.keepAliveMs ?? 30000;
        this.autoReconnect = config.autoReconnect !== false;
        this.reconnectBaseMs = config.reconnectBaseMs ?? 1000;
        this.reconnectMaxMs = config.reconnectMaxMs ?? 30000;
        this.wsCtorInject = config.WebSocketImpl;
        this.getAuthToken = config.getAuthToken;
    }

    /** Account-scoped channels whose subscribe frame must carry an `auth` token. */
    private static needsAuth(channel: string): boolean {
        return (
            channel.startsWith("account_") ||
            channel.startsWith("user_stats") ||
            channel.startsWith("pool_") ||
            channel.startsWith("notification") ||
            channel === "rfq"
        );
    }

    // ==================== lifecycle ====================

    /** Open the socket. Resolves once connected (or rejects if the first connect fails). */
    public async connect(): Promise<void> {
        this.closedByUser = false;
        if (!this.wsCtor) this.wsCtor = await resolveWebSocketCtor(this.wsCtorInject);
        await this.openSocket();
    }

    private openSocket(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const Ctor = this.wsCtor as WebSocketCtor;
            let settled = false;
            let socket: WebSocketLike;
            try {
                socket = new Ctor(this.url);
            } catch (err) {
                reject(err);
                return;
            }
            this.ws = socket;

            socket.onopen = () => {
                this.reconnectAttempts = 0;
                this.everConnected = true;
                Logger.debug(`LighterWs::open::${this.url}`);
                this.startKeepAlive();
                // (Re)subscribe every desired channel (auth tokens are re-minted here for account channels).
                for (const channel of this.desiredChannels) void this.sendSubscribe(channel);
                this.emit("open", undefined);
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };

            socket.onmessage = (ev: any) => this.handleMessage(ev?.data);

            socket.onerror = (ev: any) => {
                const message = ev?.message || ev?.error?.message || "websocket error";
                Logger.error(`LighterWs::error::${message}`);
                this.emit("error", ev);
                if (!settled) {
                    settled = true;
                    reject(new Error(`LighterWs::connect failed: ${message}`));
                }
            };

            socket.onclose = () => {
                Logger.debug("LighterWs::close");
                this.stopKeepAlive();
                this.ws = null;
                this.emit("close", undefined);
                // Only auto-reconnect a previously-established connection; a failed initial connect stays dead
                // (the connect() promise already rejected — don't spin a hidden background loop).
                if (this.everConnected && !this.closedByUser && this.autoReconnect) this.scheduleReconnect();
            };
        });
    }

    /** Close the socket and cancel reconnection/keepalive. */
    public close(): void {
        this.closedByUser = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.stopKeepAlive();
        try {
            this.ws?.close();
        } catch {
            /* ignore */
        }
        this.ws = null;
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        const backoff = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempts);
        // Full jitter to avoid a thundering herd of clients reconnecting in lockstep.
        const delay = Math.floor(Math.random() * backoff);
        this.reconnectAttempts += 1;
        Logger.debug(`LighterWs::reconnect scheduled in ${delay}ms (attempt ${this.reconnectAttempts})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.emit("reconnect", this.reconnectAttempts);
            this.openSocket().catch((err) => {
                Logger.error(`LighterWs::reconnect failed: ${err?.message}`);
                if (!this.closedByUser && this.autoReconnect) this.scheduleReconnect();
            });
        }, delay);
    }

    private startKeepAlive(): void {
        this.stopKeepAlive();
        // Any application-level frame satisfies the server's 2-minute keepalive requirement. We send a small
        // JSON ping well inside that window; it also works in the browser (no ws-level ping frame there).
        this.keepAliveTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WS_OPEN) {
                try {
                    this.ws.send(JSON.stringify({ type: "ping" }));
                } catch (err: any) {
                    Logger.warn(`LighterWs::keepalive send failed: ${err?.message}`);
                }
            }
        }, this.keepAliveMs);
        // Don't let the keepalive timer hold a Node process open.
        (this.keepAliveTimer as any)?.unref?.();
    }

    private stopKeepAlive(): void {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    // ==================== messaging ====================

    private handleMessage(raw: any): void {
        let msg: LighterWsMessage;
        try {
            const text = typeof raw === "string" ? raw : raw?.toString?.() ?? "";
            msg = JSON.parse(text) as LighterWsMessage;
        } catch {
            Logger.warn("LighterWs::handleMessage::non-JSON frame ignored");
            return;
        }
        // Server-initiated ping: reply so the connection stays healthy.
        if (msg.type === "ping") {
            if (this.ws && this.ws.readyState === WS_OPEN) {
                try {
                    this.ws.send(JSON.stringify({ type: "pong" }));
                } catch {
                    /* ignore */
                }
            }
            return;
        }
        // Our keepalive's pong reply is transport noise, not application data — don't surface it.
        if (msg.type === "pong") return;
        this.emit("message", msg);
        if (msg.channel) {
            const handlers = this.channelHandlers.get(LighterWs.normalizeChannel(msg.channel));
            if (handlers) for (const h of handlers) h(msg);
        }
    }

    private async sendSubscribe(channel: string): Promise<void> {
        const frame: Record<string, unknown> = { type: "subscribe", channel };
        if (LighterWs.needsAuth(channel)) {
            if (!this.getAuthToken) {
                // Should not happen — subscribe() rejects this up front — but guard the reconnect path too.
                Logger.error(`LighterWs::cannot subscribe to authed channel "${channel}" without getAuthToken`);
                return;
            }
            try {
                frame.auth = await this.getAuthToken();
            } catch (err: any) {
                Logger.error(`LighterWs::getAuthToken failed for "${channel}": ${err?.message}`);
                return;
            }
        }
        this.sendFrame(frame);
    }

    private sendUnsubscribe(channel: string): void {
        this.sendFrame({ type: "unsubscribe", channel });
    }

    private sendFrame(frame: Record<string, unknown>): void {
        if (this.ws && this.ws.readyState === WS_OPEN) {
            this.ws.send(JSON.stringify(frame));
        }
        // If not open yet, desiredChannels drives a resubscribe on the next open.
    }

    private static normalizeChannel(channel: string): string {
        return channel.replace(/:/g, "/");
    }

    // ==================== subscriptions ====================

    /**
     * Subscribe to a raw channel string (e.g. "order_book/1", "account_all/7"). Returns an unsubscribe
     * handle. Safe to call before `connect()`: the subscription is (re)sent on every connect.
     */
    public subscribe(channel: string, handler: LighterChannelHandler): Unsubscribe {
        if (LighterWs.needsAuth(channel) && !this.getAuthToken) {
            throw new Error(
                `LighterWs::channel "${channel}" is account-scoped and requires auth — pass getAuthToken in the LighterWs config (or use LighterClient with a signer).`,
            );
        }
        const key = LighterWs.normalizeChannel(channel);
        this.desiredChannels.add(channel);
        let set = this.channelHandlers.get(key);
        if (!set) {
            set = new Set();
            this.channelHandlers.set(key, set);
        }
        set.add(handler);
        void this.sendSubscribe(channel);

        return () => {
            const handlers = this.channelHandlers.get(key);
            if (handlers) {
                handlers.delete(handler);
                if (handlers.size === 0) {
                    this.channelHandlers.delete(key);
                    this.desiredChannels.delete(channel);
                    this.sendUnsubscribe(channel);
                }
            }
        };
    }

    /** Order book snapshot + batched deltas for a market. */
    public subscribeOrderBook(marketIndex: number, handler: LighterChannelHandler): Unsubscribe {
        return this.subscribe(`order_book/${marketIndex}`, handler);
    }

    /** Public trade prints for a market. */
    public subscribeTrades(marketIndex: number, handler: LighterChannelHandler): Unsubscribe {
        return this.subscribe(`trade/${marketIndex}`, handler);
    }

    /** Best bid/offer ticker for a market. */
    public subscribeTicker(marketIndex: number, handler: LighterChannelHandler): Unsubscribe {
        return this.subscribe(`ticker/${marketIndex}`, handler);
    }

    /** Rolling market stats for one market, or all markets with "all". */
    public subscribeMarketStats(marketIndexOrAll: number | "all", handler: LighterChannelHandler): Unsubscribe {
        return this.subscribe(`market_stats/${marketIndexOrAll}`, handler);
    }

    /** All account state (balances, positions, orders) for an account. */
    public subscribeAccountAll(accountIndex: number, handler: LighterChannelHandler): Unsubscribe {
        return this.subscribe(`account_all/${accountIndex}`, handler);
    }

    /** All open/closed orders for an account. */
    public subscribeAccountOrders(accountIndex: number, handler: LighterChannelHandler): Unsubscribe {
        return this.subscribe(`account_all_orders/${accountIndex}`, handler);
    }

    /** All positions for an account. */
    public subscribeAccountPositions(accountIndex: number, handler: LighterChannelHandler): Unsubscribe {
        return this.subscribe(`account_all_positions/${accountIndex}`, handler);
    }

    /** All fills for an account. */
    public subscribeAccountTrades(accountIndex: number, handler: LighterChannelHandler): Unsubscribe {
        return this.subscribe(`account_all_trades/${accountIndex}`, handler);
    }

    // ==================== event listeners ====================

    /** Register a lifecycle/message listener. Returns an unsubscribe handle. */
    public on(event: LighterWsEvent, handler: LighterWsHandler): Unsubscribe {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(handler);
        return () => this.listeners.get(event)?.delete(handler);
    }

    private emit(event: LighterWsEvent, payload: any): void {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const h of set) {
            try {
                h(payload);
            } catch (err: any) {
                Logger.error(`LighterWs::listener for "${event}" threw: ${err?.message}`);
            }
        }
    }

    /** True when the socket is open. */
    public get isConnected(): boolean {
        return !!this.ws && this.ws.readyState === WS_OPEN;
    }
}
