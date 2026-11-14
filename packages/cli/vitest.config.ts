import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { CheapestFirst } from "../../vitest.sequencer.ts";

// Tests that run the generator start TypeScript's API, a native process that takes every core: on
// a Windows runner one took about 2 s alone and over 5 s while other files started theirs, which
// slowed the tests beside them as much, those that never start it included.
const TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    name: "cli",
    setupFiles: [join(import.meta.dirname, "../../vitest.trace.ts")],
    sequence: { sequencer: CheapestFirst },
    include: ["src/**/*.test.ts"],
    testTimeout: TEST_TIMEOUT_MS,
  },
});
