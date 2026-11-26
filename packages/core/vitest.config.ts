import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { TEST_TIMEOUT_MS } from "../../vitest.timeout.ts";

export default defineConfig({
  test: {
    name: "core",
    setupFiles: [join(import.meta.dirname, "../../vitest.trace.ts")],
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
    typecheck: {
      enabled: true,
      include: ["test-types/**/*.test-d.ts"],
      tsconfig: "./test-types/tsconfig.json",
    },
  },
});
