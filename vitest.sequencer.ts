import { BaseSequencer, type TestSpecification } from "vitest/node";

// A run that stops at its first failure, as Stryker's run of each mutant does, reaches its verdict
// sooner trying the cheapest tests first. Vitest's own order puts first the longest files, those
// that start whole apps: they cover most mutants and seldom kill one, and a mutant's run reaches
// the test that kills it only after them. Without bail, Vitest's order stands, as it balances the
// workers of a whole run.
export class CheapestFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    if (!this.ctx.config.bail) return sorted;
    // A partial run, such as a mutant's, records whether the file failed but keeps the duration
    // of the last whole run, which the file's tests share.
    const rank = (file: TestSpecification): readonly [number, number] => {
      const result = this.ctx.cache.getTestSpecificationResult(file);
      const tests =
        file.testModule === undefined ? 0 : [...file.testModule.children.allTests()].length;
      const perTest = result === undefined || tests === 0 ? 0 : result.duration / tests;
      return [result?.failed ? 0 : 1, perTest];
    };
    const ranks = new Map(sorted.map((file) => [file, rank(file)]));
    return [...sorted].sort((a, b) => {
      const [failedA, costA] = ranks.get(a) ?? [1, 0];
      const [failedB, costB] = ranks.get(b) ?? [1, 0];
      return failedA - failedB || costA - costB;
    });
  }
}
