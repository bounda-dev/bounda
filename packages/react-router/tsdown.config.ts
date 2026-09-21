import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/vite.ts", "src/app.ts"],
  tsconfig: "tsconfig.build.json",
  unbundle: true,
  dts: true,
  platform: "node",
  fixedExtension: false,
  publint: true,
  attw: true,
});
