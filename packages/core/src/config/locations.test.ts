import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../contracts/errors.ts";
import { defineForgetLedger } from "../kernel/personal-data/forget-ledger.ts";
import { defineKeyWrapper } from "../kernel/personal-data/key-wrapper.ts";
import { masterKey } from "../kernel/personal-data/master-key.ts";
import { defineTenantKeyStore } from "../kernel/personal-data/tenant-key-source.ts";
import { DEFAULT_TENANT } from "../kernel/personal-data/tenant-keys.ts";
import { createMemoryForgetLedgers } from "../memory/forget-ledger.ts";
import { memory } from "../memory/index.ts";
import { createMemoryTenantKeyStore } from "../memory/tenant-key-store.ts";
import type { DataLocation } from "../modules/data-location.ts";
import { resolveConfig } from "./schema.ts";
import type { Config } from "./types.ts";

const keyWrapper = masterKey({ from: "BOUNDA_MASTER_KEY", location: "eu" });
const ledger = () => createMemoryForgetLedgers().ledgerOf(DEFAULT_TENANT);

const SAFEGUARDS =
  '"adequacy" (article 45), "standard-contractual-clauses" (article 46(2)(c)), "binding-corporate-rules" (article 47), "code-of-conduct" (article 46(2)(e)), "certification" (article 46(2)(f))';

const abroad = (path: string, location: string, fix: string, regime = "in the country US") =>
  `${path} keeps its data in "${location}", ${regime}, and storage keeps the app's in "eu", in the European Economic Area: keeping it there is a transfer, which a safeguard must allow, so declare its safeguard beside its location, one of ${SAFEGUARDS}, or keep it where the storage is and ${fix}`;

const KNOWN =
  'a country by its ISO 3166-1 alpha-2 code in lower case, such as "de", or one of "eu", "eea", "fedramp", "fedramp-high", "global"';

const kept = (
  personalData: NonNullable<NonNullable<Config["runtime"]>["personalData"]>,
  storage = memory({ location: "eu" }),
): Config => ({
  storage,
  runtime: {
    personalData: {
      keyWrapper:
        storage.location === undefined
          ? keyWrapper
          : masterKey({ from: "BOUNDA_MASTER_KEY", location: storage.location }),
      ...personalData,
    },
  },
});

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
    const wrapper = (location?: DataLocation) =>
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

  it("refuses a location Bounda does not know, wherever it is declared", () => {
    for (const location of [
      "",
      "  ",
      "uk",
      "europe",
      "jurisdiction eu",
      "fedramp-moderate",
      42,
      null,
    ]) {
      const declared = { ...memory(), location } as unknown as ReturnType<typeof memory>;
      expect(() => resolveConfig({ storage: declared })).toThrow(
        `storage declares where it keeps its data as ${JSON.stringify(location)}, which is no location Bounda knows: ${KNOWN}`,
      );
      expect(() => resolveConfig({ storage: memory(), readModels: { search: declared } })).toThrow(
        `readModels.search declares where it keeps its data as ${JSON.stringify(location)}, which is no location Bounda knows: ${KNOWN}`,
      );
      expect(() =>
        resolveConfig(
          kept(
            { keyWrapper: { ...masterKey({ from: "BOUNDA_MASTER_KEY" }), location } as never },
            memory(),
          ),
        ),
      ).toThrow(
        `runtime.personalData.keyWrapper declares where it keeps its data as ${JSON.stringify(location)}, which is no location Bounda knows: ${KNOWN}`,
      );
      expect(() => resolveConfig(kept({ tenantKeys: declared }, memory()))).toThrow(
        `runtime.personalData.tenantKeys declares where it keeps its data as ${JSON.stringify(location)}, which is no location Bounda knows: ${KNOWN}`,
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

  it("refuses a safeguard on a store kept under the storage's legal regime, which is no transfer", () => {
    expect(() =>
      resolveConfig(kept({ tenantKeys: memory({ location: "eu", safeguard: "adequacy" }) })),
    ).toThrow(
      new ConfigurationError(
        'runtime.personalData.tenantKeys keeps its data in "eu" under a safeguard, and storage keeps the app\'s in "eu", both in the European Economic Area, so keeping it there is no transfer: remove its safeguard',
      ),
    );
    expect(() =>
      resolveConfig(
        kept(
          {
            tenantKeys: memory({
              location: "fedramp",
              safeguard: "adequacy",
              adequacyScope: "data-privacy-framework",
            }),
          },
          memory({ location: "us" }),
        ),
      ),
    ).toThrow(
      'runtime.personalData.tenantKeys keeps its data in "fedramp" under a safeguard, and storage keeps the app\'s in "us", both in the country US, so keeping it there is no transfer: remove its safeguard and its adequacyScope',
    );
  });

  it("refuses a safeguard on the storage, which is where the app keeps its data", () => {
    expect(() =>
      resolveConfig({ storage: memory({ location: "us", safeguard: "certification" }) }),
    ).toThrow(
      "storage declares a safeguard, and storage is where the app keeps its data, not a transfer out of it: a safeguard belongs to a store kept in another location than storage's",
    );
  });

  it("refuses a safeguard under a storage that declares no location", () => {
    expect(() =>
      resolveConfig({
        storage: memory(),
        readModels: { search: memory({ location: "us", safeguard: "certification" }) },
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

  it("tells the case a location is written in from a location it does not know", () => {
    for (const location of ["DE", "EU", "Fedramp"]) {
      expect(() => resolveConfig(kept({ tenantKeys: { ...memory(), location } as never }))).toThrow(
        `runtime.personalData.tenantKeys declares where it keeps its data as "${location}", which is no location Bounda knows: write it "${location.toLowerCase()}": ${KNOWN}`,
      );
    }
  });

  it("accepts a store kept elsewhere under the storage's legal regime without a safeguard", () => {
    const at = (storage: DataLocation, location: DataLocation) =>
      resolveConfig(kept({ tenantKeys: memory({ location }) }, memory({ location: storage })));
    for (const [storage, location] of [
      ["eu", "de"],
      ["eu", "eea"],
      ["eu", "no"],
      ["eu", "re"],
      ["eu", "ax"],
      ["de", "fr"],
      ["eea", "is"],
      ["us", "fedramp"],
      ["us", "fedramp-high"],
      ["fedramp", "fedramp-high"],
      ["ch", "ch"],
    ] as const) {
      expect(() => at(storage, location), `${location} under ${storage}`).not.toThrow();
    }
  });

  it("refuses a store kept under another legal regime without a safeguard, by what each is", () => {
    expect(() => resolveConfig(kept({ tenantKeys: memory({ location: "fedramp" }) }))).toThrow(
      abroad("runtime.personalData.tenantKeys", "fedramp", 'give its memory() location: "eu"'),
    );
    expect(() => resolveConfig(kept({ tenantKeys: memory({ location: "gb" }) }))).toThrow(
      abroad(
        "runtime.personalData.tenantKeys",
        "gb",
        'give its memory() location: "eu"',
        "in the country GB",
      ),
    );
    expect(() => resolveConfig(kept({ tenantKeys: memory({ location: "gf" }) }))).not.toThrow();
    expect(() => resolveConfig(kept({ tenantKeys: memory({ location: "bl" }) }))).toThrow(
      abroad(
        "runtime.personalData.tenantKeys",
        "bl",
        'give its memory() location: "eu"',
        "in the country BL",
      ),
    );
    expect(() => resolveConfig(kept({ tenantKeys: memory({ location: "global" }) }))).toThrow(
      abroad(
        "runtime.personalData.tenantKeys",
        "global",
        'give its memory() location: "eu"',
        "anywhere in the world",
      ),
    );
    expect(() =>
      resolveConfig(kept({ tenantKeys: memory({ location: "eu" }) }, memory({ location: "ch" }))),
    ).toThrow(
      'runtime.personalData.tenantKeys keeps its data in "eu", in the European Economic Area, and storage keeps the app\'s in "ch", in the country CH: keeping it there is a transfer',
    );
  });

  it("refuses adequacy for a store kept where no adequacy decision covers", () => {
    const BUT_ADEQUACY =
      '"standard-contractual-clauses" (article 46(2)(c)), "binding-corporate-rules" (article 47), "code-of-conduct" (article 46(2)(e)), "certification" (article 46(2)(f))';
    const adequate = (location: string) =>
      kept({ tenantKeys: { ...memory(), location, safeguard: "adequacy" } as never });
    expect(() => resolveConfig(adequate("in"))).toThrow(
      `runtime.personalData.tenantKeys keeps its data in "in" under the safeguard "adequacy", and no adequacy decision of the European Commission covers data kept in the country IN: declare one of ${BUT_ADEQUACY}`,
    );
    expect(() => resolveConfig(adequate("global"))).toThrow(
      `runtime.personalData.tenantKeys keeps its data in "global" under the safeguard "adequacy", and no adequacy decision of the European Commission covers data kept anywhere in the world: declare one of ${BUT_ADEQUACY}`,
    );
    for (const location of ["ch", "gb", "jp", "br"]) {
      expect(() => resolveConfig(adequate(location)), location).not.toThrow();
    }
    expect(() =>
      resolveConfig(
        kept(
          { tenantKeys: memory({ location: "de", safeguard: "adequacy" }) },
          memory({ location: "ch" }),
        ),
      ),
    ).not.toThrow();
    expect(() =>
      resolveConfig(
        kept({
          tenantKeys: memory({ location: "global", safeguard: "standard-contractual-clauses" }),
        }),
      ),
    ).not.toThrow();
  });

  it("holds adequacy where a decision covers some providers alone to the decision's adequacyScope", () => {
    const BUT_ADEQUACY =
      '"standard-contractual-clauses" (article 46(2)(c)), "binding-corporate-rules" (article 47), "code-of-conduct" (article 46(2)(e)), "certification" (article 46(2)(f))';
    const placed = (placement: object) =>
      kept({ tenantKeys: { ...memory(), ...placement } as never });
    const US =
      'the adequacy decision for data kept in the country US, Commission Implementing Decision (EU) 2023/1795, is for organisations in the United States included in the Data Privacy Framework List of the US Department of Commerce alone: once you verified the provider keeping it is on the Data Privacy Framework List, with an active certification that covers the data transferred, human resources data or other, declare adequacyScope: "data-privacy-framework" beside the safeguard, or declare one of';
    for (const location of ["us", "fedramp", "fedramp-high"]) {
      expect(() => resolveConfig(placed({ location, safeguard: "adequacy" }))).toThrow(
        `runtime.personalData.tenantKeys keeps its data in "${location}" under the safeguard "adequacy", and ${US} ${BUT_ADEQUACY}`,
      );
      expect(() =>
        resolveConfig(
          placed({ location, safeguard: "adequacy", adequacyScope: "data-privacy-framework" }),
        ),
      ).not.toThrow();
    }
    expect(() =>
      resolveConfig(placed({ location: "us", safeguard: "adequacy", adequacyScope: "pipeda" })),
    ).toThrow(
      `runtime.personalData.tenantKeys keeps its data in "us" under the safeguard "adequacy" with the adequacyScope "pipeda", and ${US} ${BUT_ADEQUACY}`,
    );
    expect(() => resolveConfig(placed({ location: "ca", safeguard: "adequacy" }))).toThrow(
      `runtime.personalData.tenantKeys keeps its data in "ca" under the safeguard "adequacy", and the adequacy decision for data kept in the country CA, Commission Decision 2002/2/EC, is for recipients subject to the Personal Information Protection and Electronic Documents Act (PIPEDA) alone: once you verified the provider keeping it is subject to PIPEDA for the data, as a private-sector organisation is for personal information it collects, uses or discloses in the course of commercial activities, declare adequacyScope: "pipeda" beside the safeguard, or declare one of ${BUT_ADEQUACY}`,
    );
    const config = resolveConfig(
      placed({ location: "ca", safeguard: "adequacy", adequacyScope: "pipeda" }),
    );
    expect(config.runtime.personalData.tenantKeys?.adequacyScope).toBe("pipeda");
    expect(() =>
      resolveConfig(placed({ location: "ch", safeguard: "adequacy", adequacyScope: "pipeda" })),
    ).toThrow(
      'runtime.personalData.tenantKeys keeps its data in "ch" under the safeguard "adequacy" with the adequacyScope "pipeda", and the adequacy decision for data kept in the country CH covers every recipient there: remove its adequacyScope',
    );
    for (const safeguard of [undefined, "standard-contractual-clauses"]) {
      expect(() =>
        resolveConfig(
          placed({ location: "us", safeguard, adequacyScope: "data-privacy-framework" }),
        ),
      ).toThrow(
        'runtime.personalData.tenantKeys declares the adequacyScope "data-privacy-framework" without the safeguard "adequacy": an adequacyScope says which part of a partial adequacy decision allows keeping the data, so declare it beside safeguard: "adequacy", or remove it',
      );
    }
    expect(() =>
      resolveConfig(
        placed({ location: "us", safeguard: "adequacy", adequacyScope: "Data-Privacy-Framework" }),
      ),
    ).toThrow(
      'runtime.personalData.tenantKeys declares the adequacyScope "Data-Privacy-Framework", which is none of "pipeda" (CA, Commission Decision 2002/2/EC), "data-privacy-framework" (US, Commission Implementing Decision (EU) 2023/1795)',
    );
    expect(() =>
      resolveConfig(
        placed({ location: "us", safeguard: "certification", adequacyScope: "nothing" }),
      ),
    ).toThrow('declares the adequacyScope "nothing", which is none of');
  });

  it('refuses a storage in "global", which keeps the app\'s data in no jurisdiction', () => {
    expect(() => resolveConfig({ storage: memory({ location: "global" }) })).toThrow(
      'storage declares the location "global", and storage is where the app keeps its data, which "global" places in no jurisdiction: declare where it keeps it, or no location',
    );
  });
});
