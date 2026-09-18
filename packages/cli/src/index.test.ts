import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@bounda-dev/cli", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@bounda-dev/cli");
  });
});
