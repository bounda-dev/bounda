import { describe, expect, it } from "vitest";
import { defineForgetLedger } from "../kernel/personal-data/forget-ledger.ts";
import { defineKeyWrapper } from "../kernel/personal-data/key-wrapper.ts";
import { masterKey } from "../kernel/personal-data/master-key.ts";
import { defineTenantKeyStore } from "../kernel/personal-data/tenant-key-source.ts";
import { DEFAULT_TENANT } from "../kernel/personal-data/tenant-keys.ts";
import { createMemoryForgetLedgers } from "../memory/forget-ledger.ts";
import { memory } from "../memory/index.ts";
import { createMemoryTenantKeyStore } from "../memory/tenant-key-store.ts";
import { resolveConfig } from "./schema.ts";
import type { Config } from "./types.ts";

const keyWrapper = masterKey({ from: "BOUNDA_MASTER_KEY", location: "eu" });
const ledger = () => createMemoryForgetLedgers().ledgerOf(DEFAULT_TENANT);

const kept = (
  personalData: NonNullable<NonNullable<Config["runtime"]>["personalData"]>,
  storage = memory({ location: "eu" }),
): Config => ({ storage, runtime: { personalData: { keyWrapper, ...personalData } } });

describe("checkLocations", () => {
  it("lets every store declare a location of its own while the storage declares none", () => {
    expect(() =>
      resolveConfig({
        storage: memory(),
        readModels: { search: memory({ location: "us" }), totals: memory() },
        runtime: {
          personalData: {
            keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
            tenantKeys: memory({ location: "ch" }),
            forgetLedger: { store: defineForgetLedger(ledger) },
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts every store kept where the storage declares it is", () => {
    const config = resolveConfig({
      storage: memory({ location: "eu" }),
      readModels: { search: memory({ location: "eu" }) },
      runtime: {
        personalData: {
          keyWrapper,
          tenantKeys: defineTenantKeyStore(createMemoryTenantKeyStore, { location: "eu" }),
          forgetLedger: { store: memory({ location: "eu" }) },
        },
      },
    });
    expect(config.readModels.search?.location).toBe("eu");
  });

  it("refuses a read model kept elsewhere than the storage, or that declares nowhere", () => {
    expect(() =>
      resolveConfig({
        storage: memory({ location: "eu" }),
        readModels: { search: memory({ location: "us" }) },
      }),
    ).toThrow(
      'readModels.search keeps its data in "us", and storage keeps the app\'s in "eu": every store is kept where the storage is, so give its memory() location: "eu"',
    );
    expect(() =>
      resolveConfig({ storage: memory({ location: "eu" }), readModels: { search: memory() } }),
    ).toThrow(
      'readModels.search declares no location, and storage keeps the app\'s in "eu": every store is kept where the storage is, so give its memory() location: "eu"',
    );
  });

  it("refuses a tenant key store kept elsewhere, by what declares it", () => {
    expect(() => resolveConfig(kept({ tenantKeys: memory({ location: "us" }) }))).toThrow(
      'runtime.personalData.tenantKeys keeps its data in "us", and storage keeps the app\'s in "eu": every store is kept where the storage is, so give its memory() location: "eu"',
    );
    expect(() =>
      resolveConfig(kept({ tenantKeys: defineTenantKeyStore(createMemoryTenantKeyStore) })),
    ).toThrow(
      'runtime.personalData.tenantKeys declares no location, and storage keeps the app\'s in "eu": every store is kept where the storage is, so declare it through defineTenantKeyStore(create, { location: "eu" })',
    );
  });

  it("refuses a forget ledger kept elsewhere, by what declares it", () => {
    expect(() =>
      resolveConfig(
        kept({ forgetLedger: { store: defineForgetLedger(ledger, { location: "us" }) } }),
      ),
    ).toThrow(
      'runtime.personalData.forgetLedger.store keeps its data in "us", and storage keeps the app\'s in "eu": every store is kept where the storage is, so declare it through defineForgetLedger(create, { location: "eu" })',
    );
    expect(() => resolveConfig(kept({ forgetLedger: { store: memory() } }))).toThrow(
      'runtime.personalData.forgetLedger.store declares no location, and storage keeps the app\'s in "eu": every store is kept where the storage is, so give its memory() location: "eu"',
    );
  });

  it("refuses a key wrapper kept elsewhere, since the master key opens every tenant's key", () => {
    const wrapper = (location?: string) =>
      defineKeyWrapper(
        () => {
          throw new Error("never built");
        },
        location === undefined ? {} : { location },
      );
    expect(() => resolveConfig(kept({ keyWrapper: wrapper("eu") }))).not.toThrow();
    expect(() =>
      resolveConfig(kept({ keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }) })),
    ).toThrow(
      'runtime.personalData.keyWrapper declares no location, and storage keeps the app\'s in "eu": every store is kept where the storage is, so declare it through masterKey({ from, location: "eu" }) or defineKeyWrapper(create, { location: "eu" })',
    );
    expect(() => resolveConfig(kept({ keyWrapper: wrapper("us") }))).toThrow(
      'runtime.personalData.keyWrapper keeps its data in "us", and storage keeps the app\'s in "eu"',
    );
    expect(() => resolveConfig(kept({ keyWrapper: wrapper() }, memory()))).not.toThrow();
  });

  it("refuses a location that names no jurisdiction, wherever it is declared", () => {
    for (const location of ["", "  ", 42, null]) {
      const declared = { ...memory(), location } as unknown as ReturnType<typeof memory>;
      expect(() => resolveConfig({ storage: declared })).toThrow(
        `storage declares where it keeps its data with a jurisdiction such as "eu", not ${JSON.stringify(location)}`,
      );
      expect(() => resolveConfig({ storage: memory(), readModels: { search: declared } })).toThrow(
        `readModels.search declares where it keeps its data with a jurisdiction such as "eu", not ${JSON.stringify(location)}`,
      );
      expect(() =>
        resolveConfig(
          kept(
            { keyWrapper: { ...masterKey({ from: "BOUNDA_MASTER_KEY" }), location } as never },
            memory(),
          ),
        ),
      ).toThrow(
        `runtime.personalData.keyWrapper declares where it keeps its data with a jurisdiction such as "eu", not ${JSON.stringify(location)}`,
      );
      expect(() => resolveConfig(kept({ tenantKeys: declared }, memory()))).toThrow(
        `runtime.personalData.tenantKeys declares where it keeps its data with a jurisdiction such as "eu", not ${JSON.stringify(location)}`,
      );
    }
  });
});
