import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  unbundle: true,
  dts: true,
  platform: "node",
  fixedExtension: false,
  publint: true,
  attw: true,
});
