import { defineConfig, masterKey } from "@bounda-dev/core/config";
import { postgresql } from "@bounda-dev/postgresql";

const url = process.env.DATABASE_URL;
if (url === undefined) throw new Error("Set DATABASE_URL, see .env.example");
const keys = process.env.TENANT_KEYS_URL;
if (keys === undefined) throw new Error("Set TENANT_KEYS_URL, see .env.example");

export default defineConfig({
  storage: postgresql({ url }),
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
      // The tenant's key, in another database: a backup of DATABASE_URL never carries it.
      tenantKeys: postgresql({ url: keys }),
    },
  },
});
