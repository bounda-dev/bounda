import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "adapter-postgresql",
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
