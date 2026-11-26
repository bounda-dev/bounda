import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { CheapestFirst } from "../../vitest.sequencer.ts";
import { TEST_TIMEOUT_MS } from "../../vitest.timeout.ts";

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
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
  },
});
