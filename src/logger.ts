/**
 * Injectable logger. The SDK never logs on its own — it routes through whatever the host app installs
 * via {@link setLogger}. The default is a no-op so the SDK is silent unless a logger is provided.
 *
 * This replaces the internal `Logger` dependency the code carried inside loky-backend; the SDK must not
 * pull in an application logging stack.
 */
export interface LighterLogger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

const noopLogger: LighterLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
};

let activeLogger: LighterLogger = noopLogger;

/** Install a logger (e.g. console, pino, winston). Pass nothing / a partial to reset to no-op. */
export function setLogger(logger: Partial<LighterLogger> | null | undefined): void {
    if (!logger) {
        activeLogger = noopLogger;
        return;
    }
    activeLogger = {
        debug: logger.debug ? logger.debug.bind(logger) : noopLogger.debug,
        info: logger.info ? logger.info.bind(logger) : noopLogger.info,
        warn: logger.warn ? logger.warn.bind(logger) : noopLogger.warn,
        error: logger.error ? logger.error.bind(logger) : noopLogger.error,
    };
}

/** Internal accessor used across the SDK. Always reads the currently-installed logger. */
export const Logger: LighterLogger = {
    debug: (m) => activeLogger.debug(m),
    info: (m) => activeLogger.info(m),
    warn: (m) => activeLogger.warn(m),
    error: (m) => activeLogger.error(m),
};
