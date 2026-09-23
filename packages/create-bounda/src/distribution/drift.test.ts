import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { driftBetween, readTree } from "./drift.ts";

const temporary: string[] = [];

afterAll(async () => {
  await Promise.all(temporary.map((path) => rm(path, { recursive: true, force: true })));
});

describe("driftBetween", () => {
  it("names each file missing, extra or changed, and only checks regenerated files exist", () => {
    const expected = new Map([
      ["tests/api.test.ts", "added"],
      ["README.md", "new"],
      ["package-lock.json", "lock 2"],
      ["src/worker.ts", "same"],
    ]);
    const actual = new Map([
      ["README.md", "old"],
      ["package-lock.json", "lock 1"],
      ["src/worker.ts", "same"],
      ["tests/tsconfig.json", "left over"],
    ]);
    expect(driftBetween({ expected, actual, regenerated: ["package-lock.json"] })).toEqual([
      { path: "README.md", kind: "changed" },
      { path: "tests/api.test.ts", kind: "missing" },
      { path: "tests/tsconfig.json", kind: "extra" },
    ]);
    expect(driftBetween({ expected, actual: expected, regenerated: [] })).toEqual([]);
  });
});

describe("readTree", () => {
  it("reads every file by its relative path, skipping the named directories anywhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "bounda-tree-"));
    temporary.push(root);
    await mkdir(join(root, "src/+types"), { recursive: true });
    await mkdir(join(root, "node_modules/x"), { recursive: true });
    await writeFile(join(root, "README.md"), "readme");
    await writeFile(join(root, "src/worker.ts"), "worker");
    await writeFile(join(root, "src/+types/worker.ts"), "generated");
    await writeFile(join(root, "node_modules/x/index.js"), "dependency");
    const tree = await readTree(root, ["node_modules", "+types"]);
    expect([...tree.entries()].sort()).toEqual([
      ["README.md", "readme"],
      ["src/worker.ts", "worker"],
    ]);
  });
});
