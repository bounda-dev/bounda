import { cloudflare, kvTenantKeys } from "@bounda-dev/cloudflare";
import { defineConfig, masterKey } from "@bounda-dev/core/config";

export default defineConfig({
  // Every tenant's object is created in the EU and never leaves it. An object never moves: choose
  // before the first deploy, or leave it out to place each object near its first request.
  storage: cloudflare({ jurisdiction: "eu" }),
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
      // Each tenant's key, in KV, apart from its object: a restore of the object never carries it.
      tenantKeys: kvTenantKeys({ binding: "TENANT_KEYS" }),
    },
  },
});
