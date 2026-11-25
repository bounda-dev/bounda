import type { Report } from "./report.ts";

export interface SourceFile {
  readonly path: string;
  readonly source: string;
}

export interface PlanShardsArgs {
  readonly files: readonly SourceFile[];
  // The package's last report, which Stryker reads as its incremental file.
  readonly report: Report | undefined;
  // A test file's current source, undefined once it is gone.
  readonly testSource: (path: string) => string | undefined;
  readonly shards: number;
}

export interface Shard {
  readonly files: readonly string[];
  // The mutants it is predicted to run, reused ones weighed at REUSED_MUTANT_COST.
  readonly cost: number;
}

export interface PlanShardsFunction {
  (args: PlanShardsArgs): readonly Shard[];
}

// What a mutant Stryker reuses still costs, next to one it runs again. Above zero, so files
// without predicted work still spread across the shards by size.
const REUSED_MUTANT_COST = 0.01;

// The mutants per character of source, when the report gives no figure to scale by.
const DEFAULT_MUTANTS_PER_CHARACTER = 1 / 40;

// A shard's cost is the mutants Stryker will run again in it, which an incremental run reads from
// what changed since the report: every mutant of a file whose source changed or that the report
// lacks, and those a changed test file covers. The files go to the shards heaviest first, each
// to the lightest shard, so a pull request's work spreads out instead of landing wherever a file
// happens to hash.
export const planShards: PlanShardsFunction = ({ files, report, testSource, shards }) => {
  const changedTests = new Set<string>();
  for (const [path, testFile] of Object.entries(report?.testFiles ?? {})) {
    if (testFile.source !== undefined && testSource(path) === testFile.source) continue;
    for (const { id } of testFile.tests) changedTests.add(id);
  }
  const counted = files.filter(({ path }) => report?.files[path] !== undefined);
  const characters = counted.reduce((sum, { source }) => sum + source.length, 0);
  const mutants = counted.reduce(
    (sum, { path }) => sum + (report?.files[path]?.mutants.length ?? 0),
    0,
  );
  const mutantsPerCharacter =
    characters === 0 || mutants === 0 ? DEFAULT_MUTANTS_PER_CHARACTER : mutants / characters;

  const costOf = ({ path, source }: SourceFile): number => {
    const result = report?.files[path];
    if (result === undefined) return source.length * mutantsPerCharacter;
    if (result.source !== source) return result.mutants.length;
    let cost = 0;
    for (const { status, coveredBy = [], killedBy = [] } of result.mutants) {
      if (status === "Ignored") continue;
      const rerun = [...coveredBy, ...killedBy].some((test) => changedTests.has(test));
      cost += rerun ? 1 : REUSED_MUTANT_COST;
    }
    return cost;
  };

  const costs = files
    .map((file) => ({ path: file.path, cost: costOf(file) }))
    .sort((a, b) => b.cost - a.cost || (a.path < b.path ? -1 : 1));
  const loads = Array.from({ length: shards }, () => 0);
  const plan = Array.from({ length: shards }, (): string[] => []);
  for (const { path, cost } of costs) {
    const lightest = loads.indexOf(Math.min(...loads));
    plan[lightest]?.push(path);
    loads[lightest] = (loads[lightest] ?? 0) + cost;
  }
  return plan.map((paths, shard) => ({ files: paths.sort(), cost: loads[shard] ?? 0 }));
};
