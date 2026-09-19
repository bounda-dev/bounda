/// <reference types="node" />
import type { LogFields, Logger } from "../contracts/logger.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface CreateConsoleLoggerArgs {
  readonly level?: LogLevel;
}

export interface CreateConsoleLoggerFunction {
  (args?: CreateConsoleLoggerArgs): Logger;
}

const line = (level: LogLevel, message: string, fields: LogFields | undefined): string =>
  `[bounda] ${level} ${message}${fields === undefined ? "" : ` ${JSON.stringify(fields)}`}`;

/**
 * A logger that writes one line per entry to the console, with the fields as JSON. Entries below
 * `level` are dropped. The default logger of `boot()`.
 */
export const createConsoleLogger: CreateConsoleLoggerFunction = ({ level = "info" } = {}) => {
  const enabled = (candidate: LogLevel): boolean => ORDER[candidate] >= ORDER[level];
  return {
    debug: (message, fields) => {
      if (enabled("debug")) console.debug(line("debug", message, fields));
    },
    info: (message, fields) => {
      if (enabled("info")) console.info(line("info", message, fields));
    },
    warn: (message, fields) => {
      if (enabled("warn")) console.warn(line("warn", message, fields));
    },
    error: (message, fields) => {
      if (enabled("error")) console.error(line("error", message, fields));
    },
  };
};
