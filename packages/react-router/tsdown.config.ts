import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/vite.ts",
    "src/app.ts",
    "src/cloudflare/index.ts",
    "src/host/node.ts",
    "src/host/cloudflare.ts",
  ],
  tsconfig: "tsconfig.build.json",
  unbundle: true,
  dts: true,
  platform: "node",
  deps: { neverBundle: ["cloudflare:workers"] },
  fixedExtension: false,
  publint: true,
  attw: true,
});
