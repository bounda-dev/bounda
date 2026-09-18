import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core",
    typecheck: {
      enabled: true,
      include: ["test-types/**/*.test-d.ts"],
      tsconfig: "./test-types/tsconfig.json",
    },
  },
});
