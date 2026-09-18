import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@bounda-dev/adapter-sqlite", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@bounda-dev/adapter-sqlite");
  });
});
