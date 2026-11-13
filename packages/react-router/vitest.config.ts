import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { CheapestFirst } from "../../vitest.sequencer.ts";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": join(import.meta.dirname, "src/cloudflare/test-support.ts"),
    },
  },
  test: {
    name: "react-router",
    setupFiles: [join(import.meta.dirname, "../../vitest.trace.ts")],
    sequence: { sequencer: CheapestFirst },
    include: ["src/**/*.test.ts"],
  },
});
