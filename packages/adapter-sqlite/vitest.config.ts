import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "adapter-sqlite",
    include: ["src/**/*.test.ts"],
  },
});
