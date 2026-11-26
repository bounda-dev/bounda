import { ConfigurationError } from "@bounda-dev/core";
import { memory } from "@bounda-dev/core/memory";
import { describe, expect, it } from "vitest";
import { cloudflare, cloudflareStorageOf, isCloudflareDefinition } from "../src/definition.ts";

describe("cloudflare", () => {
  it("names the STORE binding unless told otherwise", () => {
    expect(cloudflare()).toEqual({
      kind: "bounda-adapter",
      name: "cloudflare",
      options: { binding: "STORE" },
      check: expect.any(Function),
    });
    expect(cloudflare({ binding: "ORDERS", tablePrefix: "app_" }).options).toEqual({
      binding: "ORDERS",
      tablePrefix: "app_",
    });
  });

  it("declares no location without a jurisdiction", () => {
    expect(cloudflare()).not.toHaveProperty("location");
  });

  it("keeps the jurisdiction it names, and tells the record of processing where the data lives", () => {
    expect(cloudflare({ jurisdiction: "eu" })).toEqual({
      kind: "bounda-adapter",
      name: "cloudflare",
      options: { binding: "STORE", jurisdiction: "eu" },
      location: "eu",
      check: expect.any(Function),
    });
  });

  it("refuses a jurisdiction that is none of Cloudflare's", () => {
    for (const jurisdiction of ["", 7, null, "de", "EU", "global"]) {
      const define = () =>
        cloudflare({ jurisdiction: jurisdiction as unknown as DurableObjectJurisdiction });
      expect(define).toThrow(ConfigurationError);
      expect(define).toThrow(
        `cloudflare({ jurisdiction }) names a Durable Object jurisdiction, one of "eu", "us", "fedramp", "fedramp-high", not ${JSON.stringify(jurisdiction)}`,
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

describe("cloudflare()'s check", () => {
  it("refuses wherever a configuration is resolved what cloudflareStorageOf refuses", () => {
    const storage = cloudflare({ jurisdiction: "eu" });
    const apart = cloudflare();
    expect(() => storage.check?.({ storage, readModels: { orders: storage } })).not.toThrow();
    expect(() => apart.check?.({ storage, readModels: { orders: apart } })).toThrow(
      "The read model orders lives in the tenant's Durable Object",
    );
    expect(() => apart.check?.({ storage: memory(), readModels: { orders: apart } })).toThrow(
      "set storage to cloudflare()",
    );
  });
});
