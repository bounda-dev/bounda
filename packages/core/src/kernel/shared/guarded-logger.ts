import type { ErrorText } from "../../config/types.ts";
import type { LogFields, Logger } from "../../contracts/logger.ts";
import { errorFields } from "./error-fields.ts";

export interface GuardedLoggerOptions {
  /**
   * Whether `error` holds what was thrown, as every call of the runtime's does. A port's code
   * logs its own fields, where `error` may be any value.
   */
  readonly thrownAsError?: boolean;
}

export interface GuardedLoggerFunction {
  (logger: Logger, errorText: ErrorText, options?: GuardedLoggerOptions): Logger;
}

type Level = keyof Logger;

const ignore = (): void => {};

// Deep enough for any field the runtime logs; past it a value is passed as it is.
const MAX_DEPTH = 8;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const reduced = (value: unknown, errorText: ErrorText, depth: number): unknown => {
  if (value instanceof Error) return errorFields({ error: value, errorText });
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => reduced(item, errorText, depth + 1));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, reduced(item, errorText, depth + 1)]),
  );
};

// The runtime hands what was thrown to the logger as `error`, never its text: here it becomes
// `errorFields`, so no call site decides on its own whether a message reaches the logs. An error
// anywhere else in the fields is reduced the same way.
const withErrorFields = (
  fields: LogFields,
  errorText: ErrorText,
  thrownAsError: boolean,
): LogFields => {
  const logged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (thrownAsError && key === "error") {
      Object.assign(logged, errorFields({ error: value, errorText }));
    } else {
      logged[key] = reduced(value, errorText, 1);
    }
  }
  return logged;
};

// No call to the logger is guarded where it is made: a logger that threw would turn whatever the
// runtime was logging, a command's rejection included, into a failure of it. An `async` method
// type-checks as `void`; left uncaught, its rejection would end the process.
export const guardedLogger: GuardedLoggerFunction = (
  logger,
  errorText,
  { thrownAsError = true } = {},
) => {
  const guard =
    (level: Level) =>
    (message: string, fields?: LogFields): void => {
      try {
        const returned: unknown =
          fields === undefined
            ? logger[level](message)
            : logger[level](message, withErrorFields(fields, errorText, thrownAsError));
        Promise.resolve(returned).catch(ignore);
      } catch {
        // A logger that fails has nowhere left to report it.
      }
    };
  return { debug: guard("debug"), info: guard("info"), warn: guard("warn"), error: guard("error") };
};
