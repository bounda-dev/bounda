import {
  cloudflare,
  durableObjectForgetLedger,
  durableObjectTenantKeys,
} from "@bounda-dev/cloudflare";
import { defineConfig, masterKey } from "@bounda-dev/core/config";

const storage = cloudflare({ jurisdiction: "eu" });

export default defineConfig({
  storage,
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
      tenantKeys: durableObjectTenantKeys({ storage }),
      forgetLedger: { store: durableObjectForgetLedger({ storage }) },
    },
  },
});
