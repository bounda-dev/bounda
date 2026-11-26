import { relative } from "node:path";
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

// Vitest shards by a hash of each file's path, which put the suite's two longest files, of about
// two minutes each, in the same shard. Shards balanced by each file's duration in the last whole
// run, read from the results cache the CI restores, the longest first, each to the lightest shard,
// finish together. Every shard computes the same split, so all of them must read the same cache:
// a file read differently would run twice or never. A file without a duration weighs the mean.
export class BalancedShards extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { shard } = this.ctx.config;
    if (shard === undefined) return files;
    const keyOf = (file: TestSpecification): string =>
      `${file.project.name}:${file.pool}:${relative(this.ctx.config.root, file.moduleId)}`;
    const known = files.flatMap((file) => {
      const duration = this.ctx.cache.getTestSpecificationResult(file)?.duration;
      return duration === undefined ? [] : [duration];
    });
    const mean = known.length === 0 ? 1 : known.reduce((sum, d) => sum + d, 0) / known.length;
    const weighed = files
      .map((file) => ({
        file,
        key: keyOf(file),
        duration: this.ctx.cache.getTestSpecificationResult(file)?.duration ?? mean,
      }))
      .sort((a, b) => b.duration - a.duration || (a.key < b.key ? -1 : 1));
    const loads = Array.from({ length: shard.count }, () => 0);
    const mine: TestSpecification[] = [];
    for (const { file, duration } of weighed) {
      const lightest = loads.indexOf(Math.min(...loads));
      loads[lightest] = (loads[lightest] ?? 0) + duration;
      if (lightest === shard.index - 1) mine.push(file);
    }
    return mine;
  }
}
