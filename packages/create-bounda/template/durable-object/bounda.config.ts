import {
  cloudflare,
  durableObjectForgetLedger,
  durableObjectTenantKeys,
} from "@bounda-dev/cloudflare";
import { defineConfig, masterKey } from "@bounda-dev/core/config";

// Every tenant's object is created in the EU and never leaves it. An object never moves: choose
// before the first deploy, or leave it out to place each object near its first request.
const storage = cloudflare({ jurisdiction: "eu" });

export default defineConfig({
  storage,
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
      // Each tenant's key and the record of whom it forgot, in the keeper object, apart from the
      // tenant's own and in the same jurisdiction: a restore of the tenant's object carries
      // neither, and forgets again whoever it brings back.
      tenantKeys: durableObjectTenantKeys({ storage }),
      forgetLedger: { store: durableObjectForgetLedger({ storage }) },
    },
  },
});
