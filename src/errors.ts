/**
 * Typed error hierarchy so callers can branch on failure kind instead of string-matching messages.
 * All SDK errors extend {@link LighterError}.
 */
export class LighterError extends Error {
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
        // Keep the prototype chain correct when targeting ES5-ish runtimes.
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** A REST/API call failed: non-2xx HTTP, a non-200 `code`, or an unparseable body. */
export class LighterApiError extends LighterError {
    constructor(
        message: string,
        /** The Lighter response `code`, if present. */
        public readonly code?: number,
        /** The HTTP status, if available. */
        public readonly status?: number,
        /** The failing method label (e.g. "createLimitOrder"). */
        public readonly method?: string,
    ) {
        super(message);
    }
}

/** The WASM signer rejected a request (bad params, out-of-range value, or an internal signer error). */
export class LighterSignerError extends LighterError {
    constructor(message: string, public readonly method?: string) {
        super(message);
    }
}

/** Client-side validation failed before hitting the network (bad size, unknown symbol, missing config). */
export class LighterValidationError extends LighterError {}
