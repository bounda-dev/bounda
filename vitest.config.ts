import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "!packages/adapter-cloudflare", "examples/*"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**"],
      exclude: ["**/*.test.ts", "**/test-types/**"],
    },
  },
});
