import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "react-router",
    include: ["src/**/*.test.ts"],
  },
});
