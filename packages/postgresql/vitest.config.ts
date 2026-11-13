import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// Stryker stops a mutant's run at its first failing test, and Vitest runs first the files that
// failed or took longest last time, which often puts the restore tests first: they run whole apps,
// cover most of the adapter and seldom fail. Last, they run only on what the store tests let through.
class RestoreLast extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const isRestore = (file: TestSpecification): boolean =>
      file.moduleId.endsWith("/restore.test.ts");
    return [...sorted.filter((file) => !isRestore(file)), ...sorted.filter(isRestore)];
  }
}

export default defineConfig({
  test: {
    name: "postgresql",
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    sequence: { sequencer: RestoreLast },
  },
});
