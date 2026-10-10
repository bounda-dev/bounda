import type { Logger } from "@bounda-dev/core";

/**
 * What the objects that log here wrote, as `[message, fields]` by level, emptied by the tests.
 */
export const logs = { info: [] as unknown[][], error: [] as unknown[][] };

export const recordingLogger: Logger = {
  debug: () => undefined,
  info: (...entry) => void logs.info.push(entry),
  warn: () => undefined,
  error: (...entry) => void logs.error.push(entry),
};
