import { cloudflare, kvTenantKeys } from "@bounda-dev/cloudflare";
import { defineConfig, masterKey } from "@bounda-dev/core/config";

export default defineConfig({
  storage: cloudflare(),
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
      // Each tenant's key, in KV, apart from its object: a restore of the object never carries it.
      tenantKeys: kvTenantKeys({ binding: "TENANT_KEYS" }),
    },
  },
});
