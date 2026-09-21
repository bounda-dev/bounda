import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsoleLogger } from "./console-logger.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createConsoleLogger", () => {
  it("writes one line per entry with the fields as JSON", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createConsoleLogger();
    logger.info("started", { role: "all" });
    logger.error("failed");
    expect(info).toHaveBeenCalledWith('[bounda] info started {"role":"all"}');
    expect(error).toHaveBeenCalledWith("[bounda] error failed");
  });

  it("drops entries below the configured level", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createConsoleLogger({ level: "warn" });
    logger.debug("noise");
    logger.warn("careful");
    expect(debug).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    createConsoleLogger({ level: "debug" }).debug("loud");
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith("[bounda] debug loud");
    expect(warn).toHaveBeenCalledWith("[bounda] warn careful");
  });

  it("gates every level, including info and warn", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const quiet = createConsoleLogger({ level: "error" });
    quiet.info("skipped", { a: 1 });
    quiet.warn("skipped too");
    quiet.error("kept", { code: 1 });
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('[bounda] error kept {"code":1}');
    createConsoleLogger({ level: "warn" }).info("also skipped");
    expect(info).not.toHaveBeenCalled();
  });
});
