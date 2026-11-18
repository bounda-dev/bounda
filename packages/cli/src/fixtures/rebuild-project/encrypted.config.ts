import type { Adapter } from "@bounda-dev/core/adapter";
import { defineConfig, defineTenantKeyStore, masterKey } from "@bounda-dev/core/config";
import { memory } from "@bounda-dev/core/memory";

// A storage over a file it encrypts under the tenant's keys: it opens as the database in memory
// once handed them, and names in `globalThis.encryptedOpenedFor` every tenant whose keys it was
// handed, and keeps its tenant key store in `globalThis.encryptedKeys`. The file stays in the
// clear until `ENCRYPTED_FREE` is set, as one another connection holds.
const openedFor: string[] = [];
Reflect.set(globalThis, "encryptedOpenedFor", openedFor);
// The tenant of each set of keys it was handed.
const keysOf: string[] = [];
Reflect.set(globalThis, "encryptedKeysOf", keysOf);
const keys = memory().createTenantKeyStore();
Reflect.set(globalThis, "encryptedKeys", keys);
const database = memory();

const encrypted = (tenant: string): Adapter => ({
  ...memory(),
  encryptedFile: {
    database: "app.db",
    open: async ({ keys: access }) => {
      keysOf.push(access.tenant);
      if ((await access.current()) !== null) openedFor.push(tenant);
      let state: "current" | "clear" = "clear";
      return {
        ...database,
        fileEncryption: {
          database: "app.db",
          state: () => state,
          refresh: async () => state,
          settle: async () => {
            if (process.env.ENCRYPTED_FREE === "1") state = "current";
            return state;
          },
        },
      };
    },
  },
});

// A read model's file of its own, encrypted under the key in force from the start.
const reports: Adapter = {
  ...memory(),
  encryptedFile: {
    database: "reports.db",
    open: async () => ({
      ...memory(),
      fileEncryption: {
        database: "reports.db",
        state: () => "current",
        refresh: async () => "current",
        settle: async () => "current",
      },
    }),
  },
};

export default defineConfig(({ tenant }) => {
  const storage = encrypted(tenant);
  return {
    storage,
    readModels: { reports, audit: storage },
    runtime: {
      role: "all",
      personalData: {
        keyWrapper: masterKey({ from: "ENCRYPTED_MASTER" }),
        tenantKeys: defineTenantKeyStore(() => keys),
      },
    },
  };
});
