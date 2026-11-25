import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "ci-scripts",
    include: ["**/*.test.ts"],
  },
});
