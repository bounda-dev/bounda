import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "create-bounda",
    setupFiles: [join(import.meta.dirname, "../../vitest.trace.ts")],
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
