import { describe, expect, it } from "vitest";
import { memory } from "../memory/index.ts";
import { defineConfig } from "./define-config.ts";

describe("defineConfig", () => {
  it("returns the very object it is given", () => {
    const config = { storage: memory(), runtime: { role: "web" as const } };
    expect(defineConfig(config)).toBe(config);
  });
});
