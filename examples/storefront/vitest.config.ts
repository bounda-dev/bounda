import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "example-storefront",
    include: ["tests/**/*.test.ts"],
  },
});
