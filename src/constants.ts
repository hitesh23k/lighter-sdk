/**
 * Static Lighter protocol constants: venues, hosts, signer chain ids, endpoint paths, and the
 * enum codes used across the order/leverage/tx APIs. Product-neutral — no integrator/partner accounts
 * are baked in; a builder (integrator) fee is supplied per-client by the caller (see LighterRestClient).
 */
export default class LighterConstant {
    public static readonly NETWORK = "lighter";

    /** Chain ids passed to the Go signer's CreateClient. */
    public static readonly CHAIN_ID_MAINNET = 304;
    public static readonly CHAIN_ID_TESTNET = 300;

    /**
     * Perp venues. The zk-Lighter L2 (USDC) and the Robinhood-Chain Lighter instance (USDG) are separate
     * Lighter deployments: same signing scheme and REST shapes, but a different host, signer chainId, and
     * account namespace (a user's account_index on one is unrelated to the other).
     */
    public static readonly VENUE = {
        ZK: "zk",
        ROBINHOOD: "robinhood",
    } as const;

    /**
     * Host + signer chainId per venue. Robinhood-Chain Lighter mainnet signs with chainId 466324
     * (NOT 4663 — that is Robinhood Chain's Ethereum L2 id, a different number).
     */
    public static readonly VENUE_CONFIG = {
        zk: {
            mainnetBaseUrl: "https://mainnet.zklighter.elliot.ai",
            testnetBaseUrl: "https://testnet.zklighter.elliot.ai",
            chainIdMainnet: 304,
            chainIdTestnet: 300,
        },
        robinhood: {
            mainnetBaseUrl: "https://api.rh.lighter.xyz",
            testnetBaseUrl: "https://api.rh-testnet.lighter.xyz",
            chainIdMainnet: 466324,
            chainIdTestnet: 300,
        },
    } as const;

    /** Resolve base URL + signer chainId for a venue and network. */
    public static resolveVenue(venue: string, isMainnet: boolean): { baseUrl: string; chainId: number } {
        const map = LighterConstant.VENUE_CONFIG as Record<
            string,
            { mainnetBaseUrl: string; testnetBaseUrl: string; chainIdMainnet: number; chainIdTestnet: number }
        >;
        const cfg = map[venue];
        if (!cfg) {
            // Fail loud rather than silently signing/routing an unknown venue against the zk host+chainId.
            throw new Error(`LighterConstant::resolveVenue::Unknown Lighter venue "${venue}"`);
        }
        return {
            baseUrl: isMainnet ? cfg.mainnetBaseUrl : cfg.testnetBaseUrl,
            chainId: isMainnet ? cfg.chainIdMainnet : cfg.chainIdTestnet,
        };
    }

    /** API-key indexes {0,1,2,3} are reserved by Lighter for desktop/mobile; programmatic keys start at 4. */
    public static readonly RESERVED_API_KEY_INDEX_MAX = 3;

    /** api_key_index is a uint8 in the signer ABI, so the usable programmatic range is 4..255. */
    public static readonly MAX_API_KEY_INDEX = 255;

    public static readonly ENDPOINTS = {
        status: "/api/v1/status",
        tokenlist: "/api/v1/tokenlist",
        orderBooks: "/api/v1/orderBooks",
        orderBookDetails: "/api/v1/orderBookDetails",
        account: "/api/v1/account",
        accountsByL1Address: "/api/v1/accountsByL1Address",
        apikeys: "/api/v1/apikeys",
        accountLimits: "/api/v1/accountLimits",
        accountActiveOrders: "/api/v1/accountActiveOrders",
        accountInactiveOrders: "/api/v1/accountInactiveOrders",
        positionFunding: "/api/v1/positionFunding",
        pnl: "/api/v1/pnl",
        trades: "/api/v1/trades",
        recentTrades: "/api/v1/recentTrades",
        fundings: "/api/v1/fundings",
        fundingRates: "/api/v1/funding-rates",
        candles: "/api/v1/candles",
        markPriceCandles: "/api/v1/markPriceCandles",
        nextNonce: "/api/v1/nextNonce",
        sendTx: "/api/v1/sendTx",
        sendTxBatch: "/api/v1/sendTxBatch",
    } as const;

    /**
     * uint8 transaction-type codes for POST /sendTx. The WASM signer returns the txType alongside
     * the signed txInfo, so these are informational/fallback — confirm exact values against
     * `github.com/elliottech/lighter-go` constants before relying on them directly.
     */
    public static readonly TX_TYPE = {
        changePubKey: 8,
        createOrder: 14,
        cancelOrder: 15,
        cancelAllOrders: 16,
        modifyOrder: 17,
        updateLeverage: 20,
        approveIntegrator: 45,
    } as const;

    /** A reasonable default ApproveIntegrator validity window (epoch MS). The user re-approves after this. */
    public static readonly INTEGRATOR_APPROVAL_TTL_MS = 365 * 24 * 60 * 60 * 1000;

    /** Lighter order-type codes (verified against elliottech/lighter-python SignerClient). */
    public static readonly ORDER_TYPE = {
        LIMIT: 0,
        MARKET: 1,
        STOP_LOSS: 2,
        STOP_LOSS_LIMIT: 3,
        TAKE_PROFIT: 4,
        TAKE_PROFIT_LIMIT: 5,
        TWAP: 6,
    } as const;

    /** Lighter time-in-force codes (verified against elliottech/lighter-python SignerClient). */
    public static readonly TIME_IN_FORCE = {
        IMMEDIATE_OR_CANCEL: 0,
        GOOD_TILL_TIME: 1,
        POST_ONLY: 2,
    } as const;

    /** Lighter uses `is_ask`: true = sell/short leg, false = buy/long leg. */
    public static readonly IS_ASK = {
        SHORT: true,
        LONG: false,
    } as const;

    /** Margin modes for SignUpdateLeverage. */
    public static readonly MARGIN_MODE = {
        CROSS: 0,
        ISOLATED: 1,
    } as const;

    /** client_order_index is a uint48 in the order tx; must stay below 2^48. */
    public static readonly MAX_CLIENT_ORDER_INDEX = 281474976710655;

    /**
     * Initial-margin-fraction scale: an integer `fraction` maps to margin% = fraction/100, so
     * leverage = 10000 / fraction (e.g. 500 → 5.00% → 20x). 1x = 10000 (the upper bound).
     */
    public static readonly MARGIN_FRACTION_SCALE = 10000;

    /** Funding is paid hourly on Lighter perps. */
    public static readonly FUNDING_INTERVAL_SECONDS = 3600;

    /** Integrator (builder) fee is a uint32 fraction of this tick: 500 = 5 bps. Lighter caps perps at 10 bps. */
    public static readonly INTEGRATOR_FEE_TICK = 1_000_000;
}
