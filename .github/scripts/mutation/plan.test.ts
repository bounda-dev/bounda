import { describe, expect, it } from "vitest";
import type { SourceFile } from "./files.ts";
import { planShards } from "./plan.ts";
import type { MutantResult, Report } from "./report.ts";

const mutants = (count: number, fields: Partial<MutantResult> = {}): readonly MutantResult[] =>
  Array.from({ length: count }, () => ({ status: "Killed", coveredBy: ["0"], ...fields }));

const file = (path: string, source = `// ${path}`): SourceFile => ({ path, source });

const unchanged = (report: Report) => (path: string) => report.testFiles?.[path]?.source;

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
    expect(plan[0]?.cost).toBe(10);
    expect(plan[1]?.cost).toBeCloseTo(0.2);
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
    expect(plan[0]?.cost).toBeCloseTo(5 + 5 * 0.01);
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
    expect(plan[0]?.cost).toBe(4);
  });

  it("leaves ignored mutants out", () => {
    const report: Report = {
      files: {
        "a.ts": { source: "a", mutants: mutants(4, { status: "Ignored", coveredBy: ["0"] }) },
      },
      testFiles: { "t.test.ts": { source: "old", tests: [{ id: "0", name: "t" }] } },
    };
    const plan = planShards({
      files: [file("a.ts", "a")],
      report,
      testSource: () => "new",
      shards: 1,
    });
    expect(plan[0]?.cost).toBe(0);
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
    expect(plan[0]?.cost).toBeCloseTo(10 * 0.01 + 5);
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
    expect(plan[0]?.cost).toBeCloseTo(10 * 0.01);
  });

  it("plans the same way for the same input, whatever the files' order", () => {
    const files = ["c.ts", "a.ts", "b.ts", "d.ts"].map((path) => file(path));
    const args = { report: undefined, testSource: () => undefined, shards: 2 };
    expect(planShards({ ...args, files })).toEqual(
      planShards({ ...args, files: [...files].reverse() }),
    );
  });
});
