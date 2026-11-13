import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Tests on a file commit many write transactions, each synced to disk: on a Windows runner the
// slowest took about 8 s, waiting on nothing but the disk, for what takes under 100 ms elsewhere.
const TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    name: "sqlite",
    setupFiles: [join(import.meta.dirname, "../../vitest.trace.ts"), "src/test-setup.ts"],
    include: ["src/**/*.test.ts"],
    testTimeout: TEST_TIMEOUT_MS,
  },
});
