import { describe, expect, it } from "vitest";
import { runInOrder, type SqlTransaction } from "./database.ts";
import type { SqlFragment } from "./query-builder.ts";

const recording = (batching: boolean) => {
  const calls: string[] = [];
  const tx: SqlTransaction = {
    raw: null,
    run: async (sql, params) => {
      calls.push(`run ${sql} ${JSON.stringify(params)}`);
    },
    all: async () => [],
    ...(batching
      ? {
          batch: async (statements: readonly SqlFragment[]) => {
            calls.push(`batch ${statements.map(({ sql }) => sql).join("; ")}`);
          },
        }
      : {}),
  };
  return { tx, calls };
};

const statements: readonly SqlFragment[] = [
  { sql: "A", params: [] },
  { sql: "B", params: [1] },
];

describe("runInOrder", () => {
  it("hands every statement to the driver's batch at once", async () => {
    const { tx, calls } = recording(true);
    await runInOrder(tx, statements);
    expect(calls).toEqual(["batch A; B"]);
  });

  it("runs them one by one, in order, on a driver without one", async () => {
    const { tx, calls } = recording(false);
    await runInOrder(tx, statements);
    expect(calls).toEqual(["run A []", "run B [1]"]);
  });

  it("sends nothing when there is nothing to run", async () => {
    const { tx, calls } = recording(true);
    await runInOrder(tx, []);
    expect(calls).toEqual([]);
  });
});
