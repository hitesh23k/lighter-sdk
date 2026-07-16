/** A parsed inbound WebSocket message. Lighter tags every frame with a `type` like `update/order_book`
 * or `subscribed/account_all_trades`, and (for channel streams) echoes the `channel` it belongs to. */
export interface LighterWsMessage {
    /** e.g. "connected", "subscribed/order_book", "update/order_book", "ping", "pong". */
    type: string;
    /** The channel this frame belongs to, when applicable (e.g. "order_book/1"). */
    channel?: string;
    [key: string]: unknown;
}

/** Minimal structural type for a WebSocket constructor (browser `WebSocket` or the Node `ws` package). */
export interface WebSocketLike {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: ((ev: any) => void) | null;
    onclose: ((ev: any) => void) | null;
    onerror: ((ev: any) => void) | null;
    onmessage: ((ev: any) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface LighterWsConfig {
    /** Perp venue (LighterConstant.VENUE): "zk" (default) or "robinhood". Picks the stream host. */
    venue?: string;
    /** Default true (mainnet). */
    isMainnet?: boolean;
    /** Full override of the wss URL (rare); otherwise derived from venue + network. */
    url?: string;
    /** Connect read-only (appends ?readonly=true). */
    readonly?: boolean;
    /**
     * WebSocket implementation. Defaults to the global `WebSocket` (browser / Node >= 22); on older Node,
     * the SDK dynamically imports the optional `ws` package. Pass this to force a specific implementation.
     */
    WebSocketImpl?: WebSocketCtor;
    /**
     * Provider for the account-channel auth token. Required to subscribe to authenticated channels
     * (`account_*`, `user_stats`, `pool_*`, `notification`, `rfq`) — those subscribe frames carry an
     * `auth` field. Re-invoked on each (re)subscribe so an expiring token (~7h) is refreshed on reconnect.
     */
    getAuthToken?: () => string | Promise<string>;
    /** Keepalive frame interval (ms). Must be < 120000 (server closes idle connections at 2 min). Default 30000. */
    keepAliveMs?: number;
    /** Auto-reconnect on unexpected close. Default true. */
    autoReconnect?: boolean;
    /** Initial reconnect backoff (ms). Default 1000. */
    reconnectBaseMs?: number;
    /** Max reconnect backoff (ms). Default 30000. */
    reconnectMaxMs?: number;
}

export type LighterWsEvent = "open" | "close" | "error" | "message" | "reconnect";
export type LighterWsHandler = (payload: any) => void;
export type LighterChannelHandler = (message: LighterWsMessage) => void;
/** Call to remove a subscription/listener. */
export type Unsubscribe = () => void;
