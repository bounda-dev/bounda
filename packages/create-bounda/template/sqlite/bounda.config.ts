import { defineConfig, masterKey } from "@bounda-dev/core/config";
import { sqlite } from "@bounda-dev/sqlite";

// Where the host keeps the databases, which the record of processing states and every store must
// share: the app refuses to start on one kept elsewhere. Say where yours run before you deploy.
const location = "eu";

export default defineConfig({
  storage: sqlite({ path: process.env.BOUNDA_DB ?? "./data/app.db", location }),
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
      // The tenant's key, apart from the database: a copy of ./data never carries it.
      tenantKeys: sqlite({ path: process.env.BOUNDA_KEYS_DB ?? "./keys/tenant-keys.db", location }),
    },
  },
});
