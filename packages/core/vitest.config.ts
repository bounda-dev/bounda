import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core",
    setupFiles: [join(import.meta.dirname, "../../vitest.trace.ts")],
    typecheck: {
      enabled: true,
      include: ["test-types/**/*.test-d.ts"],
      tsconfig: "./test-types/tsconfig.json",
    },
  },
});
