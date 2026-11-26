import type { FileResult, MutantResult, Report, TestDefinition, TestFile } from "./report.ts";

export interface ShardReport {
  readonly report: Report;
  // The files the shard mutated. Its report also carries the others, as the incremental file
  // handed them in: those results are not the shard's to give.
  readonly files: ReadonlySet<string>;
}

export interface MergeReportsArgs {
  readonly shards: readonly ShardReport[];
  // The report the shards started from: it gives the files of a shard that left no report.
  readonly previous: Report | undefined;
  // The files the package mutates now; any other is gone.
  readonly keep: readonly string[];
}

export interface MergeReportsFunction {
  (args: MergeReportsArgs): Report;
}

const keyOf = (path: string, { name, location }: TestDefinition): string =>
  [path, name, location?.start.line ?? "", location?.start.column ?? ""].join("\u0000");

const keysById = (report: Report): ReadonlyMap<string, string> =>
  new Map(
    Object.entries(report.testFiles ?? {}).flatMap(([path, { tests }]) =>
      tests.map((test): [string, string] => [test.id, keyOf(path, test)]),
    ),
  );

const mutantKey = ({ mutatorName, replacement, location }: MutantResult): string =>
  [
    mutatorName,
    replacement,
    location?.start.line,
    location?.start.column,
    location?.end.line,
    location?.end.column,
  ].join("\u0000");

// Stryker writes a mutant's duration only when it tests the mutant, so a mutant a shard reused
// takes the one the previous report kept. Without that, the plan would soon know no mutant's time.
const withDurations = (result: FileResult, earlier: FileResult | undefined): FileResult => {
  const durations = new Map(
    (earlier?.mutants ?? []).flatMap((mutant): [string, number][] =>
      mutant.duration === undefined ? [] : [[mutantKey(mutant), mutant.duration]],
    ),
  );
  return {
    ...result,
    mutants: result.mutants.map((mutant): MutantResult => {
      const duration = mutant.duration ?? durations.get(mutantKey(mutant));
      return duration === undefined ? mutant : { ...mutant, duration };
    }),
  };
};

// Test ids are only unique within one report: each shard numbers the same tests its own way, so
// the merged report numbers them anew and maps every mutant's `coveredBy` and `killedBy` onto
// those numbers. Without that, a merged report read as an incremental file would credit a kill to
// the wrong test.
export const mergeReports: MergeReportsFunction = ({ shards, previous, keep }) => {
  const sources: readonly Report[] = [
    ...shards.map(({ report }) => report),
    ...(previous === undefined ? [] : [previous]),
  ];
  const [first] = sources;
  if (first === undefined) throw new Error("No report to merge");

  const idByKey = new Map<string, string>();
  const testFiles: Record<string, TestFile> = {};
  const testSources = shards.length > 0 ? shards.map(({ report }) => report) : sources;
  for (const report of testSources) {
    for (const [path, testFile] of Object.entries(report.testFiles ?? {})) {
      if (testFiles[path] !== undefined) continue;
      testFiles[path] = {
        ...testFile,
        tests: testFile.tests.map((test) => {
          const id = String(idByKey.size);
          idByKey.set(keyOf(path, test), id);
          return { ...test, id };
        }),
      };
    }
  }

  const renumber = (report: Report, result: FileResult): FileResult => {
    const keys = keysById(report);
    const map = (ids: readonly string[] | undefined): readonly string[] | undefined =>
      ids?.flatMap((id) => {
        const merged = idByKey.get(keys.get(id) ?? "");
        return merged === undefined ? [] : [merged];
      });
    return {
      ...result,
      mutants: result.mutants.map((mutant): MutantResult => {
        const coveredBy = map(mutant.coveredBy);
        const killedBy = map(mutant.killedBy);
        return {
          ...mutant,
          ...(coveredBy === undefined ? {} : { coveredBy }),
          ...(killedBy === undefined ? {} : { killedBy }),
        };
      }),
    };
  };

  const files: Record<string, FileResult> = {};
  for (const path of keep) {
    // A shard that mutated the file and left no result for it found no mutant there.
    const shard = shards.find(({ files: owned }) => owned.has(path))?.report;
    const report = shard ?? previous;
    const result = report?.files[path];
    if (report === undefined || result === undefined) continue;
    files[path] = renumber(
      report,
      shard === undefined ? result : withDurations(result, previous?.files[path]),
    );
  }
  return { ...first, files, testFiles };
};
