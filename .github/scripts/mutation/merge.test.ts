import { describe, expect, it } from "vitest";
import type { SourceFile } from "./files.ts";
import { mergeReports } from "./merge.ts";
import type { Report } from "./report.ts";

const tests = {
  "a.test.ts": {
    source: "a",
    tests: [
      { id: "0", name: "first", location: { start: { line: 1, column: 1 } } },
      { id: "1", name: "second", location: { start: { line: 5, column: 1 } } },
    ],
  },
};

// The same tests as `tests`, numbered the other way round, as another shard may.
const renumbered = {
  "a.test.ts": {
    source: "a",
    tests: [
      { id: "7", name: "second", location: { start: { line: 5, column: 1 } } },
      { id: "9", name: "first", location: { start: { line: 1, column: 1 } } },
    ],
  },
};

const sources = (...paths: readonly string[]): readonly SourceFile[] =>
  paths.map((path) => ({ path, source: path }));

const shardOne: Report = {
  schemaVersion: "1.0",
  files: {
    "one.ts": {
      source: "one",
      mutants: [{ status: "Killed", coveredBy: ["0", "1"], killedBy: ["1"] }],
    },
    "two.ts": { source: "stale", mutants: [{ status: "Survived", coveredBy: ["0"] }] },
  },
  testFiles: tests,
};

const shardTwo: Report = {
  schemaVersion: "1.0",
  files: {
    "one.ts": { source: "stale", mutants: [{ status: "Survived", coveredBy: ["9"] }] },
    "two.ts": {
      source: "two",
      mutants: [{ status: "Killed", coveredBy: ["7", "9"], killedBy: ["9"] }],
    },
  },
  testFiles: renumbered,
};

describe("mergeReports", () => {
  it("takes each file from the shard that mutated it", () => {
    const merged = mergeReports({
      shards: [
        { report: shardOne, files: new Set(["one.ts"]) },
        { report: shardTwo, files: new Set(["two.ts"]) },
      ],
      previous: undefined,
      keep: sources("one.ts", "two.ts"),
    });
    expect(merged.files["one.ts"]?.source).toBe("one");
    expect(merged.files["two.ts"]?.source).toBe("two");
    expect(merged.schemaVersion).toBe("1.0");
  });

  it("maps every shard's test ids onto one numbering", () => {
    const merged = mergeReports({
      shards: [
        { report: shardOne, files: new Set(["one.ts"]) },
        { report: shardTwo, files: new Set(["two.ts"]) },
      ],
      previous: undefined,
      keep: sources("one.ts", "two.ts"),
    });
    const nameOf = new Map(
      merged.testFiles?.["a.test.ts"]?.tests.map(({ id, name }) => [id, name]),
    );
    const names = (ids: readonly string[] | undefined) => ids?.map((id) => nameOf.get(id));
    expect(names(merged.files["one.ts"]?.mutants[0]?.killedBy)).toEqual(["second"]);
    expect(names(merged.files["two.ts"]?.mutants[0]?.killedBy)).toEqual(["first"]);
    expect(names(merged.files["two.ts"]?.mutants[0]?.coveredBy)).toEqual(["second", "first"]);
  });

  it("takes from the previous report the files of a shard that left no report", () => {
    const previous: Report = {
      files: { "two.ts": { source: "previous", mutants: [{ status: "Killed", killedBy: ["9"] }] } },
      testFiles: renumbered,
    };
    const merged = mergeReports({
      shards: [{ report: shardOne, files: new Set(["one.ts"]) }],
      previous,
      keep: sources("one.ts", "two.ts"),
    });
    expect(merged.files["two.ts"]?.source).toBe("previous");
    const first = merged.testFiles?.["a.test.ts"]?.tests.find(({ name }) => name === "first");
    expect(merged.files["two.ts"]?.mutants[0]?.killedBy).toEqual([first?.id]);
  });

  it("keeps with no mutant a file the shard that mutated it has no result for", () => {
    const merged = mergeReports({
      shards: [{ report: shardOne, files: new Set(["one.ts", "three.ts"]) }],
      previous: {
        files: { "three.ts": { source: "old", mutants: [{ status: "Survived" }] } },
      },
      keep: sources("one.ts", "three.ts"),
    });
    expect(Object.keys(merged.files)).toEqual(["one.ts", "three.ts"]);
    expect(merged.files["three.ts"]).toEqual({
      language: "typescript",
      source: "three.ts",
      mutants: [],
    });
  });

  it("leaves out a file no shard mutated and the previous report lacks", () => {
    const merged = mergeReports({
      shards: [{ report: shardOne, files: new Set(["one.ts"]) }],
      previous: undefined,
      keep: sources("one.ts", "three.ts"),
    });
    expect(Object.keys(merged.files)).toEqual(["one.ts"]);
  });

  it("drops files the package no longer mutates and ids of tests that are gone", () => {
    const merged = mergeReports({
      shards: [
        {
          report: {
            ...shardOne,
            testFiles: {
              "a.test.ts": { source: "a", tests: tests["a.test.ts"].tests.slice(0, 1) },
            },
          },
          files: new Set(["one.ts", "two.ts"]),
        },
      ],
      previous: undefined,
      keep: sources("one.ts"),
    });
    expect(Object.keys(merged.files)).toEqual(["one.ts"]);
    expect(merged.files["one.ts"]?.mutants[0]?.killedBy).toEqual([]);
  });

  it("refuses to merge nothing", () => {
    expect(() => mergeReports({ shards: [], previous: undefined, keep: [] })).toThrow();
  });
});
