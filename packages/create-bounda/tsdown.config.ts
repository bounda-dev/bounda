import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  tsconfig: "tsconfig.build.json",
  unbundle: true,
  dts: true,
  platform: "node",
  fixedExtension: false,
  publint: true,
  attw: true,
});
