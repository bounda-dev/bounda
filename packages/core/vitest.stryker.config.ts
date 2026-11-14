import { defineConfig } from "vitest/config";
import { CheapestFirst } from "../../vitest.sequencer.ts";

export default defineConfig({
  test: {
    name: "core",
    include: ["src/**/*.test.ts"],
    typecheck: { enabled: false },
    sequence: { sequencer: CheapestFirst },
  },
});
