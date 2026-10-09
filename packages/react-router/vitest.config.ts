import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": join(import.meta.dirname, "src/cloudflare/test-support.ts"),
    },
  },
  test: {
    name: "react-router",
    include: ["src/**/*.test.ts"],
  },
});
