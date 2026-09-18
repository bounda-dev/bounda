import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("create-bounda", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("create-bounda");
  });
});
