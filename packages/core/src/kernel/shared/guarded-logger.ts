import type { LogFields, Logger } from "../../contracts/logger.ts";

export interface GuardedLoggerFunction {
  (logger: Logger): Logger;
}

type Level = keyof Logger;

const ignore = (): void => {};

// No call to the logger is guarded where it is made: a logger that threw would turn whatever the
// runtime was logging, a command's rejection included, into a failure of it. An `async` method
// type-checks as `void`; left uncaught, its rejection would end the process.
export const guardedLogger: GuardedLoggerFunction = (logger) => {
  const guard =
    (level: Level) =>
    (message: string, fields?: LogFields): void => {
      try {
        const returned: unknown =
          fields === undefined ? logger[level](message) : logger[level](message, fields);
        Promise.resolve(returned).catch(ignore);
      } catch {
        // A logger that fails has nowhere left to report it.
      }
    };
  return { debug: guard("debug"), info: guard("info"), warn: guard("warn"), error: guard("error") };
};
