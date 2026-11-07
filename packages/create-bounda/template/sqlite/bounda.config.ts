import { defineConfig, masterKey } from "@bounda-dev/core/config";
import { sqlite } from "@bounda-dev/sqlite";

export default defineConfig({
  storage: sqlite({ path: process.env.BOUNDA_DB ?? "./data/app.db" }),
  runtime: {
    personalData: { keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }) },
  },
});
