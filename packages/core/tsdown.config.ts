import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/adapter/index.ts"],
  unbundle: true,
  dts: true,
  platform: "neutral",
  publint: true,
  attw: true,
});
