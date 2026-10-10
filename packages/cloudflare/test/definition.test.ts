import { describe, expect, it } from "vitest";
import { cloudflare, isCloudflareDefinition } from "../src/definition.ts";

describe("cloudflare", () => {
  it("names the STORE binding unless told otherwise", () => {
    expect(cloudflare()).toEqual({
      kind: "bounda-adapter",
      name: "cloudflare",
      options: { binding: "STORE" },
    });
    expect(cloudflare({ binding: "ORDERS", tablePrefix: "app_" }).options).toEqual({
      binding: "ORDERS",
      tablePrefix: "app_",
    });
  });
});

describe("isCloudflareDefinition", () => {
  it("tells cloudflare() from anything else", () => {
    expect(isCloudflareDefinition(cloudflare())).toBe(true);
    for (const value of [
      null,
      undefined,
      "cloudflare",
      { name: "cloudflare" },
      { kind: "other", name: "cloudflare" },
      { kind: "bounda-adapter", name: "sqlite" },
    ]) {
      expect(isCloudflareDefinition(value)).toBe(false);
    }
  });
});
