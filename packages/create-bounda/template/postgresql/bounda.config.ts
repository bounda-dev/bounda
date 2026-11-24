import { defineConfig, masterKey } from "@bounda-dev/core/config";
import { postgresql } from "@bounda-dev/postgresql";

const url = process.env.DATABASE_URL;
if (url === undefined) throw new Error("Set DATABASE_URL, see .env.example");
const keys = process.env.TENANT_KEYS_URL;
if (keys === undefined) throw new Error("Set TENANT_KEYS_URL, see .env.example");
const ledger = process.env.FORGET_LEDGER_URL;
if (ledger === undefined) throw new Error("Set FORGET_LEDGER_URL, see .env.example");

// Where the servers keep their data, and the app's host its master key, which the record of
// processing states and every store must share: the app refuses to start on one kept elsewhere.
// Say where yours run before you deploy.
const location = "eu";

export default defineConfig({
  storage: postgresql({ url, location }),
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY", location }),
      // The tenant's key, in another database: a backup of DATABASE_URL never carries it.
      tenantKeys: postgresql({ url: keys, location }),
      // The record of whom the app forgot, in another database too: a restore of DATABASE_URL
      // forgets again whoever it brings back.
      forgetLedger: { store: postgresql({ url: ledger, location }) },
    },
  },
});
