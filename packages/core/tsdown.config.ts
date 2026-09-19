import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/config/index.ts",
    "src/adapter/index.ts",
    "src/adapter/testing/index.ts",
    "src/memory/index.ts",
  ],
  unbundle: true,
  dts: true,
  platform: "neutral",
  publint: true,
  attw: true,
});
