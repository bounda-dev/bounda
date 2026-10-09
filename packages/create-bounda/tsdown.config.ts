import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  tsconfig: "tsconfig.build.json",
  unbundle: true,
  dts: false,
  platform: "node",
  fixedExtension: false,
  publint: true,
});
