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

const SAFEGUARDS =
  '"adequacy" (article 45), "standard-contractual-clauses" (article 46(2)(c)), "binding-corporate-rules" (article 47), "code-of-conduct" (article 46(2)(e)), "certification" (article 46(2)(f))';

const abroad = (path: string, location: string, fix: string) =>
  `${path} keeps its data in "${location}", and storage keeps the app's in "eu": keeping it there is a transfer, which a safeguard must allow, so declare its safeguard beside its location, one of ${SAFEGUARDS}, or keep it where the storage is and ${fix}`;

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
    ).toThrow(abroad("readModels.search", "us", 'give its memory() location: "eu"'));
    expect(() =>
      resolveConfig({ storage: memory({ location: "eu" }), readModels: { search: memory() } }),
    ).toThrow(
      'readModels.search declares no location, and storage keeps the app\'s in "eu": every store is kept where the storage is, or elsewhere under a safeguard, so give its memory() location: "eu"',
    );
  });

  it("refuses a tenant key store kept elsewhere, by what declares it", () => {
    expect(() => resolveConfig(kept({ tenantKeys: memory({ location: "us" }) }))).toThrow(
      abroad("runtime.personalData.tenantKeys", "us", 'give its memory() location: "eu"'),
    );
    expect(() =>
      resolveConfig(kept({ tenantKeys: defineTenantKeyStore(createMemoryTenantKeyStore) })),
    ).toThrow(
      'runtime.personalData.tenantKeys declares no location, and storage keeps the app\'s in "eu": every store is kept where the storage is, or elsewhere under a safeguard, so declare it through defineTenantKeyStore(create, { location: "eu" })',
    );
  });

  it("refuses a forget ledger kept elsewhere, by what declares it", () => {
    expect(() =>
      resolveConfig(
        kept({ forgetLedger: { store: defineForgetLedger(ledger, { location: "us" }) } }),
      ),
    ).toThrow(
      abroad(
        "runtime.personalData.forgetLedger.store",
        "us",
        'declare it through defineForgetLedger(create, { location: "eu" })',
      ),
    );
    expect(() => resolveConfig(kept({ forgetLedger: { store: memory() } }))).toThrow(
      'runtime.personalData.forgetLedger.store declares no location, and storage keeps the app\'s in "eu": every store is kept where the storage is, or elsewhere under a safeguard, so give its memory() location: "eu"',
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
      'runtime.personalData.keyWrapper declares no location, and storage keeps the app\'s in "eu": every store is kept where the storage is, or elsewhere under a safeguard, so declare it through masterKey({ from, location: "eu" }) or defineKeyWrapper(create, { location: "eu" })',
    );
    expect(() => resolveConfig(kept({ keyWrapper: wrapper("us") }))).toThrow(
      abroad(
        "runtime.personalData.keyWrapper",
        "us",
        'declare it through masterKey({ from, location: "eu" }) or defineKeyWrapper(create, { location: "eu" })',
      ),
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
  it("accepts every store kept in another location under a safeguard", () => {
    const config = resolveConfig({
      storage: memory({ location: "eu" }),
      readModels: { search: memory({ location: "ch", safeguard: "adequacy" }) },
      runtime: {
        personalData: {
          keyWrapper: masterKey({
            from: "BOUNDA_MASTER_KEY",
            location: "us",
            safeguard: "standard-contractual-clauses",
          }),
          tenantKeys: defineTenantKeyStore(createMemoryTenantKeyStore, {
            location: "ch",
            safeguard: "adequacy",
          }),
          forgetLedger: {
            store: defineForgetLedger(ledger, {
              location: "us",
              safeguard: "binding-corporate-rules",
            }),
          },
        },
      },
    });
    expect(config.readModels.search?.safeguard).toBe("adequacy");
    expect(config.runtime.personalData.tenantKeys?.safeguard).toBe("adequacy");
    for (const safeguard of ["code-of-conduct", "certification"] as const) {
      expect(() =>
        resolveConfig(kept({ tenantKeys: memory({ location: "us", safeguard }) })),
      ).not.toThrow();
    }
  });

  it("refuses a safeguard on a store kept where the storage is, which is no transfer", () => {
    expect(() =>
      resolveConfig(kept({ tenantKeys: memory({ location: "eu", safeguard: "adequacy" }) })),
    ).toThrow(
      'runtime.personalData.tenantKeys keeps its data in "eu", where storage keeps the app\'s, under a safeguard, and keeping it there is no transfer: remove its safeguard',
    );
  });

  it("refuses a safeguard on the storage, which is where the app keeps its data", () => {
    expect(() =>
      resolveConfig({ storage: memory({ location: "us", safeguard: "adequacy" }) }),
    ).toThrow(
      "storage declares a safeguard, and storage is where the app keeps its data, not a transfer out of it: a safeguard belongs to a store kept in another location than storage's",
    );
  });

  it("refuses a safeguard under a storage that declares no location", () => {
    expect(() =>
      resolveConfig({
        storage: memory(),
        readModels: { search: memory({ location: "us", safeguard: "adequacy" }) },
      }),
    ).toThrow(
      'readModels.search keeps its data in "us" under a safeguard, and storage declares no location, so nothing tells whether that is a transfer: declare where storage keeps the app\'s data',
    );
  });

  it("refuses a safeguard without a location, as an unchecked configuration may hold", () => {
    const declared = { ...memory(), safeguard: "adequacy" } as unknown as ReturnType<typeof memory>;
    expect(() => resolveConfig(kept({ tenantKeys: declared }))).toThrow(
      "runtime.personalData.tenantKeys declares a safeguard and no location: a safeguard allows keeping data in a location, so declare where it keeps its data beside it",
    );
  });

  it("refuses a derogation, and anything that is no safeguard of articles 45 to 47", () => {
    const at = (safeguard: unknown) =>
      kept({
        forgetLedger: {
          store: defineForgetLedger(ledger, { location: "us", safeguard } as never),
        },
      });
    expect(() => resolveConfig(at("derogation"))).toThrow(
      `runtime.personalData.forgetLedger.store rests keeping its data abroad on a derogation, which article 49 allows for occasional transfers alone, never for data kept there as long as the app runs: declare one of ${SAFEGUARDS}`,
    );
    for (const safeguard of ["privacy-shield", "", 7, null]) {
      expect(() => resolveConfig(at(safeguard))).toThrow(
        `runtime.personalData.forgetLedger.store declares the safeguard ${JSON.stringify(safeguard)}, which is none of ${SAFEGUARDS}`,
      );
    }
  });
});
