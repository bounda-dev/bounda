import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { CheapestFirst } from "../../vitest.sequencer.ts";
import { TEST_TIMEOUT_MS } from "../../vitest.timeout.ts";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    name: "cloudflare",
    include: ["test/**/*.test.ts"],
    sequence: { sequencer: CheapestFirst },
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
  },
});
