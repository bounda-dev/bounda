import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/config/index.ts",
    "src/adapter/index.ts",
    "src/adapter/testing/index.ts",
    "src/memory/index.ts",
    "src/node/index.ts",
    "src/testing/index.ts",
  ],
  tsconfig: "tsconfig.build.json",
  unbundle: true,
  dts: true,
  platform: "neutral",
  publint: true,
  attw: true,
});
