import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import LighterWs from "../src/ws/client";
import LighterConstant from "../src/constants";

/** Controllable fake WebSocket: records sent frames, exposes _open/_msg/_serverClose to drive the client. */
class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    static last(): FakeWebSocket {
        return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    }
    static reset(): void {
        FakeWebSocket.instances = [];
    }

    readyState = 0; // CONNECTING
    sent: string[] = [];
    onopen: ((ev: any) => void) | null = null;
    onclose: ((ev: any) => void) | null = null;
    onerror: ((ev: any) => void) | null = null;
    onmessage: ((ev: any) => void) | null = null;

    constructor(public url: string) {
        FakeWebSocket.instances.push(this);
    }
    send(data: string): void {
        this.sent.push(data);
    }
    close(): void {
        this.readyState = 3;
        this.onclose?.({});
    }
    _open(): void {
        this.readyState = 1;
        this.onopen?.({});
    }
    _msg(obj: any): void {
        this.onmessage?.({ data: JSON.stringify(obj) });
    }
    _serverClose(): void {
        this.readyState = 3;
        this.onclose?.({});
    }
    sentFrames(): any[] {
        return this.sent.map((s) => JSON.parse(s));
    }
}

async function connectFake(ws: LighterWs): Promise<FakeWebSocket> {
    const p = ws.connect();
    await vi.advanceTimersByTimeAsync(0); // flush async ctor resolution + socket construction
    const inst = FakeWebSocket.last();
    inst._open();
    await p;
    return inst;
}

beforeEach(() => {
    FakeWebSocket.reset();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("LighterWs URL resolution", () => {
    it("derives the zk mainnet stream URL", () => {
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any });
        expect((ws as any).url).toBe("wss://mainnet.zklighter.elliot.ai/stream");
    });
    it("derives robinhood + testnet + readonly", () => {
        const rh = new LighterWs({ venue: "robinhood", WebSocketImpl: FakeWebSocket as any });
        expect((rh as any).url).toBe("wss://api.rh.lighter.xyz/stream");
        const tn = new LighterWs({ isMainnet: false, readonly: true, WebSocketImpl: FakeWebSocket as any });
        expect((tn as any).url).toBe("wss://testnet.zklighter.elliot.ai/stream?readonly=true");
    });
    it("honours a full url override", () => {
        const ws = new LighterWs({ url: "wss://custom/stream", WebSocketImpl: FakeWebSocket as any });
        expect((ws as any).url).toBe("wss://custom/stream");
    });
});

describe("LighterWs subscribe/dispatch", () => {
    it("connect resolves on open and marks connected", async () => {
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any });
        const inst = await connectFake(ws);
        expect(ws.isConnected).toBe(true);
        expect(inst.url).toContain("/stream");
    });

    it("sends a subscribe frame and dispatches matching channel messages", async () => {
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any });
        const inst = await connectFake(ws);
        const got: any[] = [];
        ws.subscribeOrderBook(1, (m) => got.push(m));
        expect(inst.sentFrames()).toContainEqual({ type: "subscribe", channel: "order_book/1" });

        inst._msg({ type: "update/order_book", channel: "order_book/1", order_book: { asks: [], bids: [] } });
        expect(got).toHaveLength(1);
        expect(got[0].order_book).toBeTruthy();
    });

    it("normalizes ':' vs '/' when the server echoes a colon channel", async () => {
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any });
        const inst = await connectFake(ws);
        const got: any[] = [];
        ws.subscribe("order_book/2", (m) => got.push(m));
        inst._msg({ type: "update/order_book", channel: "order_book:2" }); // colon variant
        expect(got).toHaveLength(1);
    });

    it("delivers every frame to on('message') listeners", async () => {
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any });
        const inst = await connectFake(ws);
        const all: any[] = [];
        ws.on("message", (m) => all.push(m));
        inst._msg({ type: "update/trade", channel: "trade/1" });
        expect(all).toHaveLength(1);
    });

    it("unsubscribe sends an unsubscribe frame only when the last handler is removed", async () => {
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any });
        const inst = await connectFake(ws);
        const off1 = ws.subscribeTrades(3, () => {});
        const off2 = ws.subscribeTrades(3, () => {});
        off1();
        expect(inst.sentFrames()).not.toContainEqual({ type: "unsubscribe", channel: "trade/3" });
        off2();
        expect(inst.sentFrames()).toContainEqual({ type: "unsubscribe", channel: "trade/3" });
    });

    it("queues subscriptions made before connect and sends them on open", async () => {
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any });
        ws.subscribeTrades(3, () => {}); // public channel, before connect
        const inst = await connectFake(ws);
        await vi.advanceTimersByTimeAsync(0);
        expect(inst.sentFrames()).toContainEqual({ type: "subscribe", channel: "trade/3" });
    });
});

describe("LighterWs keepalive + ping/pong", () => {
    it("sends a keepalive ping on the interval", async () => {
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any, keepAliveMs: 30000 });
        const inst = await connectFake(ws);
        await vi.advanceTimersByTimeAsync(30000);
        expect(inst.sentFrames()).toContainEqual({ type: "ping" });
    });

    it("replies pong to a server ping and does not surface it as a message", async () => {
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any });
        const inst = await connectFake(ws);
        const msgs: any[] = [];
        ws.on("message", (m) => msgs.push(m));
        inst._msg({ type: "ping" });
        expect(inst.sentFrames()).toContainEqual({ type: "pong" });
        expect(msgs).toHaveLength(0);
    });
});

describe("LighterWs reconnect", () => {
    it("reconnects on unexpected close and resubscribes active channels", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0); // deterministic zero backoff
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any, reconnectBaseMs: 10 });
        const inst = await connectFake(ws);
        ws.subscribeOrderBook(5, () => {});

        inst._serverClose();
        expect(ws.isConnected).toBe(false);

        await vi.advanceTimersByTimeAsync(0); // fire the zero-delay reconnect timer -> constructs a new socket
        const inst2 = FakeWebSocket.last();
        expect(inst2).not.toBe(inst);
        inst2._open();
        await vi.advanceTimersByTimeAsync(0);

        expect(ws.isConnected).toBe(true);
        expect(inst2.sentFrames()).toContainEqual({ type: "subscribe", channel: "order_book/5" });
    });

    it("does not reconnect after an explicit close()", async () => {
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any });
        const inst = await connectFake(ws);
        const before = FakeWebSocket.instances.length;
        ws.close();
        await vi.advanceTimersByTimeAsync(60000);
        expect(FakeWebSocket.instances.length).toBe(before); // no new socket constructed
        expect(ws.isConnected).toBe(false);
    });

    it("respects autoReconnect:false", async () => {
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any, autoReconnect: false });
        const inst = await connectFake(ws);
        const before = FakeWebSocket.instances.length;
        inst._serverClose();
        await vi.advanceTimersByTimeAsync(60000);
        expect(FakeWebSocket.instances.length).toBe(before);
    });

    it("does NOT reconnect after a FAILED initial connect (L3)", async () => {
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any });
        const p = ws.connect();
        await vi.advanceTimersByTimeAsync(0);
        const inst = FakeWebSocket.last();
        // Simulate a connect failure: error then close, never opened.
        inst.onerror?.({ message: "refused" });
        inst.onclose?.({});
        await expect(p).rejects.toThrow(/connect failed/);
        const before = FakeWebSocket.instances.length;
        await vi.advanceTimersByTimeAsync(60000);
        expect(FakeWebSocket.instances.length).toBe(before); // no background reconnect loop
    });
});

describe("LighterWs account-channel auth (C1)", () => {
    it("throws when subscribing to an account channel without getAuthToken", async () => {
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any });
        await connectFake(ws);
        expect(() => ws.subscribeAccountAll(7, () => {})).toThrow(/requires auth/);
    });

    it("includes an auth token in the subscribe frame for account channels", async () => {
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any, getAuthToken: () => "tok-123" });
        const inst = await connectFake(ws);
        ws.subscribeAccountAll(7, () => {});
        await vi.advanceTimersByTimeAsync(0); // let the async token resolve + frame send
        expect(inst.sentFrames()).toContainEqual({ type: "subscribe", channel: "account_all/7", auth: "tok-123" });
    });

    it("public channels carry NO auth field", async () => {
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any, getAuthToken: () => "tok-123" });
        const inst = await connectFake(ws);
        ws.subscribeOrderBook(1, () => {});
        await vi.advanceTimersByTimeAsync(0);
        expect(inst.sentFrames()).toContainEqual({ type: "subscribe", channel: "order_book/1" });
    });

    it("re-mints the auth token on reconnect (token can expire)", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        let n = 0;
        const ws = new LighterWs({ WebSocketImpl: FakeWebSocket as any, reconnectBaseMs: 10, getAuthToken: () => `tok-${n++}` });
        const inst = await connectFake(ws);
        ws.subscribeAccountAll(7, () => {});
        await vi.advanceTimersByTimeAsync(0);
        expect(inst.sentFrames()).toContainEqual({ type: "subscribe", channel: "account_all/7", auth: "tok-0" });
        inst._serverClose();
        await vi.advanceTimersByTimeAsync(0);
        const inst2 = FakeWebSocket.last();
        inst2._open();
        await vi.advanceTimersByTimeAsync(0);
        // fresh token on the resubscribe
        expect(inst2.sentFrames()).toContainEqual({ type: "subscribe", channel: "account_all/7", auth: "tok-1" });
    });
});
