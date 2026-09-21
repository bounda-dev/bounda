import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "example-onboarding",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
