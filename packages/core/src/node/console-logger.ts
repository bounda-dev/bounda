/// <reference types="node" />
import type { LogFields, Logger } from "../contracts/logger.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface CreateConsoleLoggerArgs {
  readonly level?: LogLevel;
  /**
   * Where every line goes, whatever its level, such as `process.stderr` for a script whose
   * standard output carries data. Defaults to the console: `debug` and `info` to standard output,
   * `warn` and `error` to standard error.
   */
  readonly stream?: { write(text: string): unknown };
}

export interface CreateConsoleLoggerFunction {
  (args?: CreateConsoleLoggerArgs): Logger;
}

const line = (level: LogLevel, message: string, fields: LogFields | undefined): string =>
  `[bounda] ${level} ${message}${fields === undefined ? "" : ` ${JSON.stringify(fields)}`}`;

/**
 * A logger that writes one line per entry to the console, or to `stream`, with the fields as JSON.
 * Entries below `level` are dropped.
 */
export const createConsoleLogger: CreateConsoleLoggerFunction = ({
  level = "info",
  stream,
} = {}) => {
  const enabled = (candidate: LogLevel): boolean => ORDER[candidate] >= ORDER[level];
  const write = (candidate: LogLevel, text: string): void => {
    if (stream === undefined) console[candidate](text);
    else stream.write(`${text}\n`);
  };
  const at =
    (candidate: LogLevel): Logger["info"] =>
    (message, fields) => {
      if (enabled(candidate)) write(candidate, line(candidate, message, fields));
    };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
};
