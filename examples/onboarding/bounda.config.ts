import { defineConfig, masterKey } from "@bounda-dev/core/config";
import { postgresql } from "@bounda-dev/postgresql";
import { sqlite } from "@bounda-dev/sqlite";

const url = process.env.DATABASE_URL;
const keys = process.env.TENANT_KEYS_URL;
// Every database keeps its data in the EU: the record of processing says so, and the app refuses
// to start on a store declared anywhere else.
const location = "eu";

export default defineConfig({
  storage:
    url === undefined
      ? sqlite({ path: "./data/onboarding.db", location })
      : postgresql({ url, location }),
  ports: {
    user: { emailSender: process.env.EMAIL_SENDER === "memory" ? "memory" : "console" },
  },
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
      tenantKeys:
        keys === undefined
          ? sqlite({ path: "./keys/tenant-keys.db", location })
          : postgresql({ url: keys, location }),
    },
  },
});
