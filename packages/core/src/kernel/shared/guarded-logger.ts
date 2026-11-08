import type { ErrorText } from "../../config/types.ts";
import type { LogFields, Logger } from "../../contracts/logger.ts";
import { errorFields } from "./error-fields.ts";

export interface GuardedLoggerFunction {
  (logger: Logger, errorText: ErrorText): Logger;
}

type Level = keyof Logger;

const ignore = (): void => {};

// The runtime hands what was thrown to the logger as `error`, never its text: here it becomes
// `errorFields`, so no call site decides on its own whether a message reaches the logs. Any other
// field holding an error is reduced the same way.
const withErrorFields = (fields: LogFields, errorText: ErrorText): LogFields => {
  const logged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "error") Object.assign(logged, errorFields({ error: value, errorText }));
    else logged[key] = value instanceof Error ? errorFields({ error: value, errorText }) : value;
  }
  return logged;
};

// No call to the logger is guarded where it is made: a logger that threw would turn whatever the
// runtime was logging, a command's rejection included, into a failure of it. An `async` method
// type-checks as `void`; left uncaught, its rejection would end the process.
export const guardedLogger: GuardedLoggerFunction = (logger, errorText) => {
  const guard =
    (level: Level) =>
    (message: string, fields?: LogFields): void => {
      try {
        const returned: unknown =
          fields === undefined
            ? logger[level](message)
            : logger[level](message, withErrorFields(fields, errorText));
        Promise.resolve(returned).catch(ignore);
      } catch {
        // A logger that fails has nowhere left to report it.
      }
    };
  return { debug: guard("debug"), info: guard("info"), warn: guard("warn"), error: guard("error") };
};
