import { describe, expect, it } from "vitest";
import { runInOrder, type SqlTransaction, withBatchedWrites } from "./database.ts";
import type { SqlFragment } from "./query-builder.ts";

const recording = (batching: boolean, { failing = "" } = {}) => {
  const calls: string[] = [];
  const fail = (sql: string): void => {
    if (sql === failing) throw new Error(`${sql} failed`);
  };
  const tx: SqlTransaction = {
    raw: "driver",
    run: async (sql, params) => {
      calls.push(`run ${sql} ${JSON.stringify(params)}`);
      fail(sql);
    },
    all: async (sql) => {
      calls.push(`all ${sql}`);
      fail(sql);
      return [{ sql }];
    },
    ...(batching
      ? {
          batch: async (statements: readonly SqlFragment[]) => {
            calls.push(`batch ${statements.map(({ sql }) => sql).join("; ")}`);
            for (const { sql } of statements) fail(sql);
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

describe("withBatchedWrites", () => {
  it("holds the writes back until the next read, and sends what is left as the work resolves", async () => {
    const { tx, calls } = recording(true);
    const result = await withBatchedWrites(tx, async (batched) => {
      await batched.run("A", []);
      await batched.batch?.([
        { sql: "B", params: [1] },
        { sql: "C", params: [] },
      ]);
      await runInOrder(batched, [{ sql: "D", params: [] }]);
      expect(calls).toEqual([]);
      expect(await batched.all("R", [])).toEqual([{ sql: "R" }]);
      await batched.run("E", [2]);
      return batched.raw;
    });
    expect(result).toBe("driver");
    expect(calls).toEqual(["batch A; B; C; D", "all R", "batch E"]);
  });

  it("runs the writes one by one, in order, on a driver without a batch", async () => {
    const { tx, calls } = recording(false);
    await withBatchedWrites(tx, async (batched) => {
      await batched.run("A", []);
      await batched.run("B", [1]);
      await batched.all("R", []);
    });
    expect(calls).toEqual(["run A []", "run B [1]", "all R"]);
  });

  it("sends nothing before a read, nor at the end, when no write waits", async () => {
    const { tx, calls } = recording(true);
    await withBatchedWrites(tx, async (batched) => {
      await batched.all("R", []);
      await batched.all("S", []);
    });
    expect(calls).toEqual(["all R", "all S"]);
  });

  it("fails the read a failing write is sent at, and the work even when it catches that", async () => {
    const { tx, calls } = recording(true, { failing: "B" });
    const outcome = withBatchedWrites(tx, async (batched) => {
      await batched.run("A", []);
      await batched.run("B", []);
      await expect(batched.all("R", [])).rejects.toThrow("B failed");
      await expect(batched.run("C", [])).rejects.toThrow("B failed");
      await expect(batched.batch?.([{ sql: "D", params: [] }])).rejects.toThrow("B failed");
      await expect(batched.all("S", [])).rejects.toThrow("B failed");
      return "done";
    });
    await expect(outcome).rejects.toThrow("B failed");
    expect(calls).toEqual(["batch A; B"]);
  });

  it("fails the work with a write that fails as it resolves", async () => {
    const { tx } = recording(true, { failing: "B" });
    await expect(
      withBatchedWrites(tx, async (batched) => {
        await batched.run("A", []);
        await batched.run("B", []);
        return "done";
      }),
    ).rejects.toThrow("B failed");
  });

  it("sends none of the writes held back when the work throws", async () => {
    const { tx, calls } = recording(true);
    await expect(
      withBatchedWrites(tx, async (batched) => {
        await batched.run("A", []);
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(calls).toEqual([]);
  });

  it("goes on past a read that fails when the work catches it", async () => {
    const { tx, calls } = recording(true, { failing: "R" });
    await withBatchedWrites(tx, async (batched) => {
      await batched.run("A", []);
      await expect(batched.all("R", [])).rejects.toThrow("R failed");
      await batched.run("B", []);
    });
    expect(calls).toEqual(["batch A", "all R", "batch B"]);
  });
});
