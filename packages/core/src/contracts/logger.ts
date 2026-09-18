/**
 * Structured fields attached to a log line.
 */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * The runtime logs through this interface only. Hosts provide an implementation; the kernel never
 * writes to the console itself.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const noop = (): void => {};

/**
 * Discards everything. The default in tests and in `createApp` when no logger is given.
 */
export const silentLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};
