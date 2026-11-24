import { defineConfig } from "vitest/config";
import { CheapestFirst } from "../../vitest.sequencer.ts";

export default defineConfig({
  test: {
    name: "test-containers",
    include: ["src/**/*.test.ts"],
    sequence: { sequencer: CheapestFirst },
  },
});
