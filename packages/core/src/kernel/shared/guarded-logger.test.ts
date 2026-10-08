import { describe, expect, it, onTestFinished } from "vitest";
import type { LogFields, Logger } from "../../contracts/logger.ts";
import { guardedLogger } from "./guarded-logger.ts";

describe("guardedLogger", () => {
  it("passes every level through to the logger, called as its method", () => {
    const lines: string[] = [];
    class PrefixLogger implements Logger {
      readonly prefix = "app";
      debug(message: string): void {
        lines.push(`${this.prefix} debug ${message}`);
      }
      info(message: string, fields?: LogFields): void {
        lines.push(`${this.prefix} info ${message} ${JSON.stringify(fields)}`);
      }
      warn(message: string): void {
        lines.push(`${this.prefix} warn ${message}`);
      }
      error(message: string): void {
        lines.push(`${this.prefix} error ${message}`);
      }
    }
    const logger = guardedLogger(new PrefixLogger());

    logger.debug("a");
    logger.info("b", { id: 1 });
    logger.warn("c");
    logger.error("d");

    expect(lines).toEqual(["app debug a", 'app info b {"id":1}', "app warn c", "app error d"]);
  });

  it("leaves out fields it was not given, for a logger that prints every argument", () => {
    const calls: unknown[][] = [];
    const record = (...args: unknown[]): void => {
      calls.push(args);
    };
    const logger = guardedLogger({ debug: record, info: record, warn: record, error: record });

    logger.info("sent");
    logger.info("sent", { to: "ada" });

    expect(calls).toEqual([["sent"], ["sent", { to: "ada" }]]);
  });

  it("catches what an async logger rejects with", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    onTestFinished(() => {
      process.off("unhandledRejection", listener);
    });
    const failing = async (): Promise<void> => {
      throw new Error("sink is down");
    };
    const logger = guardedLogger({ debug: failing, info: failing, warn: failing, error: failing });

    logger.info("a");
    logger.error("b");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unhandled).toEqual([]);
  });

  it("swallows what the logger throws, at every level", () => {
    const failing = (): void => {
      throw new Error("disk full");
    };
    const logger = guardedLogger({ debug: failing, info: failing, warn: failing, error: failing });

    expect(() => {
      logger.debug("a");
      logger.info("b");
      logger.warn("c");
      logger.error("d");
    }).not.toThrow();
  });
});
