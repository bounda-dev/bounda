import type { Logger } from "@bounda-dev/core";

/**
 * One JSON line per entry on `console`, which Workers Logs parses into fields: what
 * `createBoundaObject` and `createWorker` log with unless given a `logger`.
 */
export const workersLogger: Logger = {
  debug: (message, fields) => console.debug(JSON.stringify({ level: "debug", message, ...fields })),
  info: (message, fields) => console.info(JSON.stringify({ level: "info", message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: "warn", message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: "error", message, ...fields })),
};
