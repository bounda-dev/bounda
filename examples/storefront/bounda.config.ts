import { sqlite } from "@bounda-dev/adapter-sqlite";
import { defineConfig } from "@bounda-dev/core/config";

export default defineConfig({
  storage: sqlite({ path: process.env.STOREFRONT_DB ?? "./data/storefront.db" }),
  policies: {
    order: {
      sendConfirmationOnOrderPlaced: { notifier: { use: process.env.NOTIFIER ?? "console" } },
    },
  },
});
