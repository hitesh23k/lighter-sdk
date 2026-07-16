import LighterConstant from "./constants";

/**
 * Pure, dependency-free helpers for Lighter's fixed-point encoding and URL building. Lighter encodes
 * base amounts with a market's `size_decimals` and prices with its `price_decimals`; these convert
 * between human decimals and the scaled integers the signer/API expect.
 */
export default class LighterHelper {
    public static toQueryString(params: Record<string, unknown>): string {
        const searchParams = new URLSearchParams();
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== "") {
                searchParams.append(key, String(value));
            }
        });
        return searchParams.toString();
    }

    public static buildUrl(baseUrl: string, endpoint: string, query?: Record<string, unknown>): string {
        const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
        const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
        const queryString = query ? LighterHelper.toQueryString(query) : "";
        return queryString ? `${normalizedBase}${normalizedEndpoint}?${queryString}` : `${normalizedBase}${normalizedEndpoint}`;
    }

    /**
     * Scale a decimal value to Lighter's integer representation (floor extra precision).
     * Lighter base amounts use `size_decimals` and prices use `price_decimals`.
     */
    public static scaleToInt(value: number | string, decimals: number): bigint {
        const s = String(value).trim();
        const neg = s.startsWith("-");
        const unsigned = neg ? s.slice(1) : s;
        const [intPartRaw, fracRaw = ""] = unsigned.split(".");
        const intPart = intPartRaw || "0";
        const fracPart = fracRaw.padEnd(decimals, "0").slice(0, decimals); // floor extra precision
        const scaled = BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(fracPart || "0");
        return neg ? -scaled : scaled;
    }

    public static toBaseAmount(size: number | string, sizeDecimals: number): bigint {
        return LighterHelper.scaleToInt(size, sizeDecimals);
    }

    public static toPriceInt(price: number | string, priceDecimals: number): bigint {
        return LighterHelper.scaleToInt(price, priceDecimals);
    }

    /** Floor `value` to the nearest multiple of `step` (both integers already scaled to the same decimals). */
    public static floorToStep(value: bigint, step: bigint): bigint {
        if (step <= 0n) return value;
        return (value / step) * step;
    }

    /** Convert a scaled integer back to a human-readable decimal string. */
    public static fromScaledInt(value: bigint, decimals: number): string {
        const negative = value < 0n;
        const abs = negative ? -value : value;
        const base = 10n ** BigInt(decimals);
        const integer = abs / base;
        const fraction = abs % base;
        const fracStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
        return `${negative ? "-" : ""}${integer.toString()}${fracStr ? "." + fracStr : ""}`;
    }

    /**
     * Convert a target leverage to Lighter's integer initial-margin fraction.
     * leverage = SCALE / fraction, so fraction = round(SCALE / leverage). Clamped to
     * [minFraction, SCALE] — `minFraction` (the market's min_initial_margin_fraction) caps leverage,
     * SCALE (=10000) is 1x.
     */
    public static leverageToMarginFraction(leverage: number, minFraction?: number): number {
        const scale = LighterConstant.MARGIN_FRACTION_SCALE;
        const raw = Math.round(scale / Math.max(1, leverage));
        const floor = minFraction && minFraction > 0 ? minFraction : 1;
        return Math.min(scale, Math.max(floor, raw));
    }
}
