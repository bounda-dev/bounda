import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  unbundle: true,
  dts: true,
  platform: "node",
  fixedExtension: false,
  publint: true,
  attw: true,
});
