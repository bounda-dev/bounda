import { defineConfig } from "@bounda-dev/core/config";
import { sqlite } from "@bounda-dev/sqlite";

export default defineConfig({
  storage: sqlite({ path: process.env.STOREFRONT_DB ?? "./data/storefront.db" }),
  ports: {
    order: { notifier: process.env.NOTIFIER === "memory" ? "memory" : "console" },
  },
});
