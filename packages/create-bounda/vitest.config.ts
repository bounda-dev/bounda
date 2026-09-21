import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "create-bounda",
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
