import { defineConfig } from "@bounda-dev/core/config";
import { memory } from "@bounda-dev/core/memory";
import { restoring } from "./restore.config.ts";

// The storage that restores in place, with a forget ledger, whose mark tells the app.
export default defineConfig({
  storage: restoring,
  runtime: { role: "all", personalData: { forgetLedger: { store: memory() } } },
});
