import type { SourceFile } from "./files.ts";
import type { FileResult, MutantResult, Report } from "./report.ts";

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
  // The mutants it is predicted to run again.
  readonly mutants: number;
  // The minutes its job is predicted to take.
  readonly minutes: number;
}

export interface PlanShardsFunction {
  (args: PlanShardsArgs): readonly Shard[];
}

// Measured on GitHub's ubuntu-latest runners over fifteen `core` shards, full and incremental runs:
// a job took SETUP_MINUTES (checkout, build, Stryker's initial test run) and then its mutants'
// durations, each plus MUTANT_OVERHEAD_MS, spread over RUNNER_PARALLELISM.
const SETUP_MINUTES = 2;
const MUTANT_OVERHEAD_MS = 210;
const RUNNER_PARALLELISM = 2.45;

// What a mutant Stryker reuses still costs. Above zero, so files without predicted work still
// spread across the shards by size.
const REUSED_MUTANT_MS = 1;

// Stand-ins, from the same runs, for figures a report without measured mutants cannot give. The
// mutants per character are those Stryker runs.
const DEFAULT_MS_PER_TEST = 50;
const DEFAULT_MUTANT_MS = 900;
const DEFAULT_MUTANTS_PER_CHARACTER = 1 / 60;

// How many tests' worth of the report's pace a file's own is weighed against: what best predicted,
// on those runs, the durations of a file's mutants from a sample of them.
const PRIOR_TESTS = 200;

// Stryker runs neither: an ignored mutant is never tested, and one no test covers fails no test.
const notRun = ({ status }: MutantResult): boolean =>
  status === "Ignored" || status === "NoCoverage";

interface Mean {
  sum: number;
  count: number;
}

const emptyMean = (): Mean => ({ sum: 0, count: 0 });

const add = (mean: Mean, sum: number, count = 1): void => {
  mean.sum += sum;
  mean.count += count;
};

const meanOf = (mean: Mean | undefined): number | undefined =>
  mean === undefined || mean.count === 0 ? undefined : mean.sum / mean.count;

const paceOf = (mutants: readonly MutantResult[]): Mean => {
  const pace = emptyMean();
  for (const { duration, testsCompleted } of mutants) {
    if (duration !== undefined && testsCompleted !== undefined) add(pace, duration, testsCompleted);
  }
  return pace;
};

// What a file's mutants' runs will take, in milliseconds. Stryker records a duration only for the
// mutants a run tests, so a reused one is estimated from the tests it ran, at the milliseconds per
// test of the file's measured mutants weighed against PRIOR_TESTS at the report's (its tests may
// be slower or faster than most), or failing that from the mean duration of its status.
const runTimeOf = (
  report: Report | undefined,
): ((result: FileResult) => (mutant: MutantResult) => number) => {
  const all = emptyMean();
  const byStatus = new Map<string, Mean>();
  const results = Object.values(report?.files ?? {});
  for (const { status, duration } of results.flatMap(({ mutants }) => mutants)) {
    if (duration === undefined) continue;
    add(all, duration);
    const ofStatus = byStatus.get(status) ?? emptyMean();
    add(ofStatus, duration);
    byStatus.set(status, ofStatus);
  }
  const reportPace =
    meanOf(paceOf(results.flatMap(({ mutants }) => mutants))) ?? DEFAULT_MS_PER_TEST;
  const fallback = meanOf(all) ?? DEFAULT_MUTANT_MS;
  return ({ mutants }) => {
    const pace = paceOf(mutants);
    const msPerTest = (pace.sum + reportPace * PRIOR_TESTS) / (pace.count + PRIOR_TESTS);
    return (mutant) => {
      if (notRun(mutant)) return 0;
      const { status, duration, testsCompleted } = mutant;
      const ms =
        duration ??
        (testsCompleted === undefined
          ? (meanOf(byStatus.get(status)) ?? fallback)
          : testsCompleted * msPerTest);
      return ms + MUTANT_OVERHEAD_MS;
    };
  };
};

interface Cost {
  readonly ms: number;
  readonly mutants: number;
}

interface Load {
  readonly files: string[];
  ms: number;
  mutants: number;
}

// A shard's cost is the time Stryker will take on the mutants it runs again, which an incremental
// run reads from what changed since the report: every mutant of a file whose source changed or
// that the report lacks, and those a changed test file covers. Mutants differ in cost by orders
// of magnitude, as a file covered by whole-app tests runs them for each mutant, so the files are
// weighed by time, not count. They go to the shards heaviest first, each to the lightest shard, so
// a pull request's work spreads out instead of landing wherever a file happens to hash.
export const planShards: PlanShardsFunction = ({ files, report, testSource, shards }) => {
  const changedTests = new Set<string>();
  for (const [path, testFile] of Object.entries(report?.testFiles ?? {})) {
    if (testFile.source !== undefined && testSource(path) === testFile.source) continue;
    for (const { id } of testFile.tests) changedTests.add(id);
  }
  const runTime = runTimeOf(report);
  const counted = files.filter(({ path }) => report?.files[path] !== undefined);
  const characters = counted.reduce((sum, { source }) => sum + source.length, 0);
  const counts = { mutants: 0, run: 0, ms: 0 };
  for (const { path } of counted) {
    const result = report?.files[path];
    if (result === undefined) continue;
    const timeOf = runTime(result);
    for (const mutant of result.mutants) {
      counts.mutants += 1;
      if (notRun(mutant)) continue;
      counts.run += 1;
      counts.ms += timeOf(mutant);
    }
  }
  const mutantsPerCharacter =
    characters === 0 || counts.mutants === 0
      ? DEFAULT_MUTANTS_PER_CHARACTER
      : counts.run / characters;
  const msPerMutant =
    counts.run === 0 ? DEFAULT_MUTANT_MS + MUTANT_OVERHEAD_MS : counts.ms / counts.run;

  const costOf = ({ path, source }: SourceFile): Cost => {
    const result = report?.files[path];
    if (result === undefined) {
      const mutants = source.length * mutantsPerCharacter;
      return { ms: mutants * msPerMutant, mutants };
    }
    let ms = 0;
    let mutants = 0;
    const changed = result.source !== source;
    const timeOf = runTime(result);
    for (const mutant of result.mutants) {
      if (notRun(mutant)) continue;
      const { coveredBy = [], killedBy = [] } = mutant;
      if (changed || [...coveredBy, ...killedBy].some((test) => changedTests.has(test))) {
        ms += timeOf(mutant);
        mutants += 1;
      } else {
        ms += REUSED_MUTANT_MS;
      }
    }
    return { ms, mutants };
  };

  const costs = files
    .map((file) => ({ path: file.path, ...costOf(file) }))
    .sort((a, b) => b.ms - a.ms || (a.path < b.path ? -1 : 1));
  const plan = Array.from({ length: shards }, (): Load => ({ files: [], ms: 0, mutants: 0 }));
  for (const { path, ms, mutants } of costs) {
    const lightest = plan.reduce((best, shard) => (shard.ms < best.ms ? shard : best));
    lightest.files.push(path);
    lightest.ms += ms;
    lightest.mutants += mutants;
  }
  return plan.map(({ files: paths, ms, mutants }) => ({
    files: paths.sort(),
    mutants,
    minutes: SETUP_MINUTES + ms / 60_000 / RUNNER_PARALLELISM,
  }));
};
