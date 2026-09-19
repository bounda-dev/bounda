import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  tsconfig: "tsconfig.build.json",
  unbundle: true,
  dts: true,
  platform: "neutral",
  publint: true,
  attw: true,
});
