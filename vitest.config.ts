import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "examples/*", ".github/scripts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**"],
      exclude: ["**/*.test.ts", "**/test-types/**"],
      reporter: ["text-summary", "json-summary", "html"],
      // Coverage must not decrease: these sit just under the whole suite's figures, the margin
      // for the few branches whose coverage depends on timing. Raise them when coverage rises.
      thresholds: {
        lines: 98.9,
        statements: 98.6,
        functions: 97.8,
        branches: 96.1,
      },
    },
  },
});
