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
    setupFiles: [join(import.meta.dirname, "../../vitest.trace.ts")],
    include: ["src/**/*.test.ts"],
  },
});
