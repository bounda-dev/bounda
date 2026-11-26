import { describe, expect, it } from "vitest";
import type { SourceFile } from "./files.ts";
import { type PlanShardsArgs, planShards } from "./plan.ts";
import type { MutantResult, Report } from "./report.ts";

const mutants = (count: number, fields: Partial<MutantResult> = {}): readonly MutantResult[] =>
  Array.from({ length: count }, () => ({ status: "Killed", coveredBy: ["0"], ...fields }));

const file = (path: string, source = `// ${path}`): SourceFile => ({ path, source });

const unchanged = (report: Report) => (path: string) => report.testFiles?.[path]?.source;

// A plan of one shard for the files whose sources changed since the report, which run every one
// of their mutants: its minutes, less those of a shard with nothing to run, are its work.
const work = (results: Report["files"], measured: Report["files"] = {}): number => {
  const report: Report = { files: { ...measured, ...results } };
  const args: Omit<PlanShardsArgs, "files"> = { report, testSource: () => undefined, shards: 1 };
  const idle = planShards({
    ...args,
    files: Object.keys(measured).map((path) => file(path, path)),
  });
  const plan = planShards({
    ...args,
    files: [
      ...Object.keys(measured).map((path) => file(path, path)),
      ...Object.keys(results).map((path) => file(path, "changed")),
    ],
  });
  return (plan[0]?.minutes ?? 0) - (idle[0]?.minutes ?? 0);
};

describe("planShards", () => {
  it("gives every file to exactly one shard", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].map((path) => file(path));
    const plan = planShards({ files, report: undefined, testSource: () => undefined, shards: 3 });
    expect(plan).toHaveLength(3);
    expect(plan.flatMap(({ files: paths }) => paths).sort()).toEqual(files.map(({ path }) => path));
  });

  it("spreads files by size when there is no report", () => {
    const files = [
      file("big.ts", "x".repeat(300)),
      file("mid.ts", "x".repeat(200)),
      file("small.ts", "x".repeat(100)),
    ];
    const plan = planShards({ files, report: undefined, testSource: () => undefined, shards: 2 });
    expect(plan.map(({ files: paths }) => paths)).toEqual([["big.ts"], ["mid.ts", "small.ts"]]);
  });

  it("balances the shards by the time their mutants take, not by their count", () => {
    const report: Report = {
      files: {
        "slow.ts": { source: "old", mutants: mutants(10, { duration: 10_000 }) },
        "fast-1.ts": { source: "old", mutants: mutants(30, { duration: 100 }) },
        "fast-2.ts": { source: "old", mutants: mutants(30, { duration: 100 }) },
        "fast-3.ts": { source: "old", mutants: mutants(30, { duration: 100 }) },
      },
    };
    const plan = planShards({
      files: ["slow.ts", "fast-1.ts", "fast-2.ts", "fast-3.ts"].map((path) => file(path, "new")),
      report,
      testSource: () => undefined,
      shards: 2,
    });
    expect(plan.map(({ files: paths }) => paths)).toEqual([
      ["slow.ts"],
      ["fast-1.ts", "fast-2.ts", "fast-3.ts"],
    ]);
    expect(plan.map(({ mutants: count }) => count)).toEqual([10, 90]);
    expect(plan[0]?.minutes).toBeGreaterThan(plan[1]?.minutes ?? Number.POSITIVE_INFINITY);
  });

  it("predicts minutes that grow with the time the mutants take", () => {
    const one = work({ "a.ts": { source: "old", mutants: mutants(10, { duration: 60_000 }) } });
    const two = work({ "a.ts": { source: "old", mutants: mutants(10, { duration: 120_000 }) } });
    const three = work({ "a.ts": { source: "old", mutants: mutants(10, { duration: 180_000 }) } });
    expect(one).toBeGreaterThan(0);
    expect(three - two).toBeCloseTo(two - one);
    expect(two).toBeGreaterThan(one);
  });

  it("weighs a changed file by all its mutants and an unchanged one by almost nothing", () => {
    const report: Report = {
      files: {
        "changed.ts": { source: "old", mutants: mutants(10) },
        "same-1.ts": { source: "same-1", mutants: mutants(10) },
        "same-2.ts": { source: "same-2", mutants: mutants(10) },
      },
      testFiles: { "a.test.ts": { source: "test", tests: [{ id: "0", name: "a" }] } },
    };
    const plan = planShards({
      files: [file("changed.ts", "new"), file("same-1.ts", "same-1"), file("same-2.ts", "same-2")],
      report,
      testSource: unchanged(report),
      shards: 2,
    });
    expect(plan.map(({ files: paths }) => paths)).toEqual([
      ["changed.ts"],
      ["same-1.ts", "same-2.ts"],
    ]);
    expect(plan.map(({ mutants: count }) => count)).toEqual([10, 0]);
    expect(plan[0]?.minutes).toBeGreaterThan(plan[1]?.minutes ?? Number.POSITIVE_INFINITY);
  });

  it("counts the mutants a changed test file covers or kills", () => {
    const report: Report = {
      files: {
        "covered.ts": {
          source: "covered",
          mutants: [
            ...mutants(3, { coveredBy: ["1"] }),
            ...mutants(2, { coveredBy: [], killedBy: ["1"] }),
          ],
        },
        "other.ts": { source: "other", mutants: mutants(5, { coveredBy: ["0"] }) },
      },
      testFiles: {
        "kept.test.ts": { source: "kept", tests: [{ id: "0", name: "kept" }] },
        "changed.test.ts": { source: "before", tests: [{ id: "1", name: "changed" }] },
      },
    };
    const plan = planShards({
      files: [file("covered.ts", "covered"), file("other.ts", "other")],
      report,
      testSource: (path) => (path === "changed.test.ts" ? "after" : unchanged(report)(path)),
      shards: 1,
    });
    expect(plan[0]?.mutants).toBe(5);
  });

  it("treats a removed test file as changed", () => {
    const report: Report = {
      files: { "a.ts": { source: "a", mutants: mutants(4, { coveredBy: ["0"] }) } },
      testFiles: { "gone.test.ts": { source: "gone", tests: [{ id: "0", name: "gone" }] } },
    };
    const plan = planShards({
      files: [file("a.ts", "a")],
      report,
      testSource: () => undefined,
      shards: 1,
    });
    expect(plan[0]?.mutants).toBe(4);
  });

  it("leaves out the mutants Stryker does not run", () => {
    expect(
      work({
        "a.ts": {
          source: "old",
          mutants: [
            ...mutants(4, { status: "Ignored", duration: 60_000 }),
            ...mutants(4, { status: "NoCoverage", coveredBy: [], duration: 60_000 }),
          ],
        },
      }),
    ).toBe(0);
  });

  it("estimates a mutant without a duration from the tests it ran, at the report's pace", () => {
    const measured = {
      "m.ts": { source: "m.ts", mutants: mutants(1, { duration: 1000, testsCompleted: 10 }) },
    };
    expect(
      work({ "a.ts": { source: "old", mutants: mutants(1, { testsCompleted: 20 }) } }, measured),
    ).toBeCloseTo(
      work({ "a.ts": { source: "old", mutants: mutants(1, { duration: 2000 }) } }, measured),
    );
  });

  it("leans toward the pace of the file's own measured mutants", () => {
    const measured = {
      "m.ts": {
        source: "m.ts",
        mutants: mutants(1, { duration: 50_000, testsCompleted: 1000 }),
      },
    };
    const slow = mutants(1, { duration: 200_000, testsCompleted: 1000 });
    const withOther = (other: MutantResult): number =>
      work({ "a.ts": { source: "old", mutants: [...slow, other] } }, measured);
    const estimated = withOther({ status: "Killed", testsCompleted: 10 });
    expect(estimated).toBeGreaterThan(withOther({ status: "Killed", duration: 10 * 125 }));
    expect(estimated).toBeLessThan(withOther({ status: "Killed", duration: 10 * 200 }));
  });

  it("estimates a mutant with neither from the mean duration of its status", () => {
    const measured = {
      "m.ts": {
        source: "m.ts",
        mutants: [
          ...mutants(1, { status: "Timeout", duration: 30_000 }),
          ...mutants(1, { status: "Timeout", duration: 50_000 }),
          ...mutants(1, { duration: 100 }),
        ],
      },
    };
    expect(
      work({ "a.ts": { source: "old", mutants: mutants(1, { status: "Timeout" }) } }, measured),
    ).toBeCloseTo(
      work({ "a.ts": { source: "old", mutants: mutants(1, { duration: 40_000 }) } }, measured),
    );
  });

  it("estimates a file the report lacks from the report's mutants per character", () => {
    const report: Report = {
      files: { "known.ts": { source: "x".repeat(100), mutants: mutants(10) } },
    };
    const plan = planShards({
      files: [file("known.ts", "x".repeat(100)), file("new.ts", "x".repeat(50))],
      report,
      testSource: () => undefined,
      shards: 1,
    });
    expect(plan[0]?.mutants).toBeCloseTo(5);
  });

  it("weighs a file the report holds with no mutant at nothing", () => {
    const report: Report = {
      files: {
        "types.ts": { source: "x".repeat(4000), mutants: [] },
        "a.ts": { source: "a", mutants: mutants(10) },
        "b.ts": { source: "b", mutants: mutants(10) },
      },
    };
    const plan = planShards({
      files: [file("types.ts", "x".repeat(4000)), file("a.ts", "a"), file("b.ts", "b")],
      report,
      testSource: () => undefined,
      shards: 2,
    });
    expect(plan.map(({ files: paths }) => paths)).toEqual([["a.ts", "types.ts"], ["b.ts"]]);
    expect(plan.map(({ mutants: count }) => count)).toEqual([0, 0]);
  });

  it("gives no shard only files without mutants while files with them are as many as shards", () => {
    const empty = ["e-1.ts", "e-2.ts", "e-3.ts", "e-4.ts"];
    const report: Report = {
      files: {
        ...Object.fromEntries(empty.map((path) => [path, { source: path, mutants: [] }])),
        "a.ts": { source: "old", mutants: mutants(10, { duration: 1000 }) },
        "b.ts": { source: "b.ts", mutants: mutants(2) },
        "c.ts": { source: "c.ts", mutants: mutants(1) },
      },
    };
    const plan = planShards({
      files: [...empty, "a.ts", "b.ts", "c.ts"].map((path) =>
        file(path, path === "a.ts" ? "new" : path),
      ),
      report,
      testSource: () => undefined,
      shards: 3,
    });
    for (const { files: paths } of plan) {
      expect(paths.some((path) => !empty.includes(path))).toBe(true);
    }
  });

  it("plans the same way for the same input, whatever the files' order", () => {
    const files = ["c.ts", "a.ts", "b.ts", "d.ts"].map((path) => file(path));
    const args = { report: undefined, testSource: () => undefined, shards: 2 };
    expect(planShards({ ...args, files })).toEqual(
      planShards({ ...args, files: [...files].reverse() }),
    );
  });
});
