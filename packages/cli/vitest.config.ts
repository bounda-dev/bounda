import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { CheapestFirst } from "../../vitest.sequencer.ts";

export default defineConfig({
  test: {
    name: "cli",
    setupFiles: [join(import.meta.dirname, "../../vitest.trace.ts")],
    sequence: { sequencer: CheapestFirst },
    include: ["src/**/*.test.ts"],
  },
});
