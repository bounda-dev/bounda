import { sqlite } from "@bounda-dev/adapter-sqlite";
import { defineConfig } from "@bounda-dev/core/config";

export default defineConfig({
  storage: sqlite({ path: process.env.BOUNDA_DB ?? "./data/app.db" }),
});
