import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { CheapestFirst } from "../../vitest.sequencer.ts";

// Tests on a file, and the hooks that open a fresh one for each, commit many write transactions,
// each synced to disk: on a Windows runner the slowest took about 8 s, and a hook over 10 s, waiting
// on nothing but the disk, for what takes under 100 ms elsewhere.
// On a libSQL server every statement is an HTTP round trip, over a hundred to migrate each test's
// fresh tables: one that takes 0.3 s alone took about 7 s beside the rest of the suite.
const TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    name: "sqlite",
    setupFiles: [join(import.meta.dirname, "../../vitest.trace.ts"), "src/test-setup.ts"],
    sequence: { sequencer: CheapestFirst },
    include: ["src/**/*.test.ts"],
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
  },
});
