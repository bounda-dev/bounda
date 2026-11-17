import { ConfigurationError } from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { cloudflare, cloudflareStorageOf, isCloudflareDefinition } from "../src/definition.ts";

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

  it("keeps the jurisdiction it names, and tells the record of processing where the data lives", () => {
    expect(cloudflare({ jurisdiction: "eu" })).toEqual({
      kind: "bounda-adapter",
      name: "cloudflare",
      options: { binding: "STORE", jurisdiction: "eu" },
      location: "jurisdiction eu",
    });
  });

  it("refuses a jurisdiction that is not a name", () => {
    for (const jurisdiction of ["", 7, null]) {
      const define = () =>
        cloudflare({ jurisdiction: jurisdiction as unknown as DurableObjectJurisdiction });
      expect(define).toThrow(ConfigurationError);
      expect(define).toThrow(
        `cloudflare({ jurisdiction }) names a Durable Object jurisdiction, such as "eu", not ${JSON.stringify(jurisdiction)}`,
      );
    }
  });
});

describe("cloudflareStorageOf", () => {
  it("refuses a read model in the object that names another jurisdiction than its storage", () => {
    const storage = cloudflare({ jurisdiction: "eu" });
    expect(
      cloudflareStorageOf({ storage, readModels: { orders: cloudflare({ jurisdiction: "eu" }) } }),
    ).toBe(storage);
    expect(() =>
      cloudflareStorageOf({ storage, readModels: { orders: cloudflare({ tablePrefix: "rm_" }) } }),
    ).toThrow(
      'The read model orders lives in the tenant\'s Durable Object, in the jurisdiction storage names: give its cloudflare() jurisdiction: "eu" too',
    );
    expect(() =>
      cloudflareStorageOf({
        storage: cloudflare(),
        readModels: { orders: cloudflare({ jurisdiction: "eu" }) },
      }),
    ).toThrow("give its cloudflare() no jurisdiction too");
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
