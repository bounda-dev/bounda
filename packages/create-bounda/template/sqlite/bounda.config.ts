import { defineConfig } from "@bounda-dev/core/config";
import { sqlite } from "@bounda-dev/sqlite";

export default defineConfig({
  storage: sqlite({ path: process.env.BOUNDA_DB ?? "./data/app.db" }),
});
