import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "sqlite",
    include: ["src/**/*.test.ts"],
  },
});
