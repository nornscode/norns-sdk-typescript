/**
 * Where the SDK writes what it is doing. Anything with these four methods
 * works: `console`, pino, winston, or your own.
 */
export interface Logger {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

/** Logs info and above to the console, prefixed so it is easy to grep. */
export const consoleLogger: Logger = {
  debug() {},
  info: (message, ...rest) => console.log(`[norns] ${message}`, ...rest),
  warn: (message, ...rest) => console.warn(`[norns] ${message}`, ...rest),
  error: (message, ...rest) => console.error(`[norns] ${message}`, ...rest),
};

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function resolveLogger(logger: Logger | null | undefined): Logger {
  if (logger === null) return silentLogger;
  return logger ?? consoleLogger;
}
