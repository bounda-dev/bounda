/**
 * Structured fields attached to a log line.
 */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * The runtime logs through this interface only. Hosts provide an implementation; the kernel never
 * writes to the console itself. `createApp`, `boot` and `rebuildReadModel` ignore what a method
 * throws or an `async` one rejects with, so a logger that fails never fails what was being logged.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const noop = (): void => {};

/**
 * A logger that discards everything.
 */
export const silentLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};
