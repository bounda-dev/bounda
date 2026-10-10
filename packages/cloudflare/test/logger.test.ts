import { afterEach, describe, expect, it, vi } from "vitest";
import { workersLogger } from "../src/logger.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workersLogger", () => {
  it("writes each entry as one JSON line on the console method of its level", () => {
    const lines = (["debug", "info", "warn", "error"] as const).map((level) => {
      const write = vi.spyOn(console, level).mockImplementation(() => undefined);
      workersLogger[level]("bounda says", { readModel: "orders" });
      return write.mock.calls;
    });
    expect(lines).toEqual(
      ["debug", "info", "warn", "error"].map((level) => [
        [JSON.stringify({ level, message: "bounda says", readModel: "orders" })],
      ]),
    );
  });
});
