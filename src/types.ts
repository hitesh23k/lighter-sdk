/**
 * Integrator (builder) fee routing. Supply this to a {@link LighterRestClientConfig} to attach a partner
 * fee to orders placed with `applyIntegratorFee: true`. The account must have approved this integrator
 * on-chain (see the client's approve-integrator flow), else Lighter rejects the fee-bearing order.
 */
export interface LighterIntegratorConfig {
    /** The integrator (partner) account_index that collects the fee. Instance-local (differs per venue/network). */
    accountIndex: number;
    /** Taker fee as a uint32 fraction of 1e6 (500 = 5 bps). Lighter caps perps at 10 bps (1000). */
    takerFee: number;
    /** Maker fee as a uint32 fraction of 1e6. */
    makerFee: number;
}

export interface LighterRestClientConfig {
    /** Default true (mainnet). */
    isMainnet?: boolean;
    /** Override the resolved host (rare); the signer chainId always comes from venue + network. */
    baseUrl?: string;
    /** Perp venue selector (LighterConstant.VENUE): "zk" (default) or "robinhood". Picks host + signer chainId. */
    venue?: string;
    /** Optional builder-fee routing; omit to never attach an integrator fee. */
    integrator?: LighterIntegratorConfig | null;
}

/** Auth context for signed (write) transactions. */
export interface LighterSignerContext {
    apiPrivateKey: string;
    accountIndex: number;
    apiKeyIndex: number;
}

/** Per-market precision/limits from /api/v1/orderBookDetails. */
export interface LighterOrderBookDetail {
    market_id: number;
    symbol: string;
    price_decimals: number;
    size_decimals: number;
    supported_price_decimals?: number;
    supported_size_decimals?: number;
    min_base_amount: string;
    min_quote_amount: string;
    order_quote_limit?: string;
    taker_fee?: string;
    maker_fee?: string;
    last_trade_price?: number;
    /** Integer initial-margin fractions (fraction/100 = margin%); `min` = max allowed leverage. */
    default_initial_margin_fraction?: number;
    min_initial_margin_fraction?: number;
}

export interface LighterOrderBookDetailsResponse {
    code?: number;
    message?: string;
    order_book_details: LighterOrderBookDetail[];
    spot_order_book_details?: LighterOrderBookDetail[];
}

export interface LighterFundingRate {
    market_id?: number;
    /** The /funding-rates endpoint aggregates several venues (binance, bybit, hyperliquid, lighter). */
    exchange?: string;
    symbol: string;
    rate: number;
    // Some responses expose the rate under `funding_rate`; keep both optional.
    funding_rate?: number;
}

export interface LighterFundingRatesResponse {
    code?: number;
    funding_rates: LighterFundingRate[];
}

export interface LighterPosition {
    market_id: number;
    symbol: string;
    /** Direction: 1 = long, -1 = short. Size is the unsigned `position`. */
    sign: number;
    /** Unsigned position size as a string. */
    position: string;
    avg_entry_price?: string;
    position_value?: string;
    unrealized_pnl?: string;
    realized_pnl?: string;
    total_funding_paid_out?: string;
    liquidation_price?: string;
    allocated_margin?: string;
    initial_margin_fraction?: string;
    margin_mode?: number;
}

export interface LighterAccount {
    account_index: number;
    l1_address?: string;
    collateral?: string;
    available_balance?: string;
    total_asset_value?: string;
    positions?: LighterPosition[];
}

export interface LighterAccountResponse {
    code?: number;
    accounts?: LighterAccount[];
    account?: LighterAccount;
}

export interface LighterNextNonceResponse {
    code?: number;
    nonce: number;
}

export interface LighterSendTxResponse {
    code: number;
    message?: string;
    tx_hash?: string;
    predicted_execution_time_ms?: number;
    volume_quota_remaining?: number;
}

/**
 * A fill from GET /api/v1/trades. A trade has two sides; determine which side is *your* account by
 * matching `ask_account_id` / `bid_account_id` against your account index.
 */
export interface LighterTrade {
    trade_id?: number | string;
    tx_hash?: string;
    type?: string;
    market_id: number;
    size: string;
    price: string;
    usd_amount?: string;
    timestamp?: number;
    ask_account_id?: number;
    bid_account_id?: number;
    /** true = the ask (sell) side was the maker; the other side was the taker. */
    is_maker_ask?: boolean;
    taker_fee?: string;
    maker_fee?: string;
    ask_account_pnl?: string;
    bid_account_pnl?: string;
}

/** Your side of a trade, normalized for accounting. */
export interface LighterAccountFill {
    trade: LighterTrade;
    /** true = you sold (ask side). */
    isAsk: boolean;
    price: number;
    size: number;
    fee: number;
    /** Realized pnl attributed to your side of this fill. */
    pnl: number;
    timestamp: number;
}

/** An account's realized funding payment for a position, from GET /api/v1/positionFunding. */
export interface LighterPositionFunding {
    timestamp: number;
    market_id: number;
    funding_id?: number;
    /** Funding amount: negative = paid, positive = received. */
    change: string;
    rate?: string;
    position_size?: string;
    position_side?: string;
}

/** An entry from GET /api/v1/tokenlist (public, no auth). */
export interface LighterTokenListItem {
    symbol: string;
    name?: string;
    /** "PERPS" for perp-tradeable tokens. */
    market?: string;
    /** "CRYPTO" | "RWA". */
    asset_type?: string;
    categories?: string[];
    is_allowed_mainnet?: boolean;
    is_asset_allowed_mainnet?: boolean;
}

export interface LighterCreateMarketOrderParams {
    marketIndex: number;
    /** Base amount as an integer scaled by the market's size_decimals. */
    baseAmount: bigint;
    isAsk: boolean;
    reduceOnly: boolean;
    clientOrderIndex: number;
    /** Optional worst-case price (integer scaled by price_decimals, uint32) for slippage protection. */
    price?: number;
    /** Attach the configured integrator (builder) fee — only for accounts that have approved it. */
    applyIntegratorFee?: boolean;
}

/** An entry from the account's registered API keys (apikeys endpoint) — used to pick a free api_key_index. */
export interface LighterApiKeyEntry {
    api_key_index?: number;
    public_key?: string;
    [key: string]: unknown;
}

export interface LighterCreateLimitOrderParams {
    marketIndex: number;
    /** Base amount as an integer scaled by the market's size_decimals. */
    baseAmount: bigint;
    /** Limit price as an integer scaled by the market's price_decimals (uint32). */
    price: number;
    isAsk: boolean;
    clientOrderIndex: number;
    /** 'gtc' (good-till-time, 28d max), 'ioc' (immediate-or-cancel), 'alo' (add-liquidity-only / post-only). */
    timeInForce?: "gtc" | "ioc" | "alo";
    /** Force post-only (rejected if it would take). Overrides timeInForce to post-only. */
    postOnly?: boolean;
    reduceOnly?: boolean;
    applyIntegratorFee?: boolean;
}

/**
 * A resting order from accountActiveOrders. Field names follow Lighter's order conventions; typed
 * loosely (index signature) so parsing survives shape variance. `order_index` is the id needed to
 * cancel/modify.
 */
export interface LighterActiveOrder {
    order_index?: number;
    client_order_index?: number;
    market_index?: number;
    market_id?: number;
    is_ask?: boolean;
    price?: string | number;
    remaining_base_amount?: string | number;
    initial_base_amount?: string | number;
    status?: string;
    type?: number | string;
    trigger_price?: string | number;
    reduce_only?: boolean;
    order_expiry?: number;
    [key: string]: unknown;
}
