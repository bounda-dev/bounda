import { describe, expect, it } from "vitest";
import type { SqlDatabase, SqlTransaction } from "./database.ts";
import { postgresqlDialect, sqliteDialect } from "./dialect.ts";
import { createSqlTenantFence, tenantFenceTableStatement } from "./tenant-fence.ts";

// Every statement, and whether it ran in a transaction, as `write` opens one.
const recording = (rows: readonly Record<string, unknown>[] = []) => {
  const statements: (readonly [string, readonly unknown[], boolean])[] = [];
  let inside = false;
  const db: SqlDatabase = {
    run: async (sql, params) => {
      statements.push([sql, params, inside]);
    },
    all: async (sql, params) => {
      statements.push([sql, params, inside]);
      return sql.includes('FROM "fence"') ? rows : [];
    },
    write: async <T>(work: (tx: SqlTransaction) => Promise<T>): Promise<T> => {
      inside = true;
      try {
        return await work({ run: db.run, all: db.all, raw: null });
      } finally {
        inside = false;
      }
    },
  };
  return { db, statements };
};

const FROZEN = { tenant: "acme", state: "frozen", since: "2026-03-01T00:00:00.000Z" };

describe("the SQL tenant fence", () => {
  it("creates one row per fenced scope, none while open", () => {
    expect(tenantFenceTableStatement('"fence"')).toContain(
      'CREATE TABLE IF NOT EXISTS "fence" (\n    "scope" TEXT NOT NULL PRIMARY KEY,',
    );
  });

  it("lets a read or a pragma through as it is, and runs every other statement behind the fence", async () => {
    const { db, statements } = recording();
    const guarded = createSqlTenantFence({ table: '"fence"', dialect: sqliteDialect }).guard(db);
    await guarded.all('SELECT "x" FROM "t"', []);
    await guarded.run("  pragma table_info(t)", []);
    await guarded.run('INSERT INTO "t" ("x") VALUES (?)', [1]);
    await guarded.all('DELETE FROM "t" RETURNING "x"', []);
    await guarded.run("WITH x AS (SELECT 1) DELETE FROM t", []);
    expect(statements).toEqual([
      ['SELECT "x" FROM "t"', [], false],
      ["  pragma table_info(t)", [], false],
      ['SELECT "tenant", "state", "since" FROM "fence" WHERE "scope" = ?', ["app"], true],
      ['INSERT INTO "t" ("x") VALUES (?)', [1], true],
      ['SELECT "tenant", "state", "since" FROM "fence" WHERE "scope" = ?', ["app"], true],
      ['DELETE FROM "t" RETURNING "x"', [], true],
      ['SELECT "tenant", "state", "since" FROM "fence" WHERE "scope" = ?', ["app"], true],
      ["WITH x AS (SELECT 1) DELETE FROM t", [], true],
    ]);
  });

  it("takes the advisory lock shared before it reads the fence, and exclusive to change it, on an engine with one", async () => {
    const { db, statements } = recording();
    const fence = createSqlTenantFence({
      table: '"fence"',
      dialect: postgresqlDialect,
      lock: ["bounda:s.checkpoints", "bounda:tenant-fence"],
      scope: "t-1",
    });
    await fence.guard(db).write(async () => undefined);
    await fence.store(db).set({ state: "frozen", tenant: "acme", since: FROZEN.since });
    expect(statements.map(([sql, params]) => [sql, params])).toEqual([
      [
        "SELECT pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))",
        ["bounda:s.checkpoints", "bounda:tenant-fence"],
      ],
      ['SELECT "tenant", "state", "since" FROM "fence" WHERE "scope" = $1', ["t-1"]],
      [
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        ["bounda:s.checkpoints", "bounda:tenant-fence"],
      ],
      ['SELECT "tenant", "state", "since" FROM "fence" WHERE "scope" = $1', ["t-1"]],
      [
        'INSERT INTO "fence" ("scope", "tenant", "state", "since") VALUES ($1, $2, $3, $4) ON CONFLICT ("scope") DO UPDATE SET "tenant" = excluded."tenant", "state" = excluded."state", "since" = excluded."since"',
        ["t-1", "acme", "frozen", FROZEN.since],
      ],
    ]);
  });

  it("refuses a write under a fence its writer does not pass, and writes nothing", async () => {
    const { db, statements } = recording([FROZEN]);
    const fence = createSqlTenantFence({ table: '"fence"', dialect: sqliteDialect });
    await expect(fence.guard(db).run('DELETE FROM "t"', [])).rejects.toMatchObject({
      code: "TENANT_FROZEN",
      tenant: "acme",
      frozenAt: FROZEN.since,
    });
    await expect(fence.guard(db, "forgotten").run('DELETE FROM "t"', [])).rejects.toMatchObject({
      code: "TENANT_FROZEN",
    });
    expect(statements.some(([sql]) => sql.startsWith("DELETE"))).toBe(false);
    expect(await fence.store(db).read()).toEqual({
      state: "frozen",
      tenant: "acme",
      since: FROZEN.since,
    });
  });

  it("lets the writes of a forgetting through its own fence, and no other", async () => {
    const forgotten = { ...FROZEN, state: "forgotten" };
    const { db, statements } = recording([forgotten]);
    const fence = createSqlTenantFence({ table: '"fence"', dialect: sqliteDialect });
    await fence.guard(db, "forgotten").run('DELETE FROM "t"', []);
    await expect(fence.guard(db).run('DELETE FROM "t"', [])).rejects.toMatchObject({
      code: "TENANT_FORGOTTEN",
      forgottenAt: FROZEN.since,
    });
    expect(statements.filter(([sql]) => sql.startsWith("DELETE"))).toHaveLength(1);
  });

  it("removes the row to open, and leaves a fence as it is when set to what it holds", async () => {
    const { db, statements } = recording([FROZEN]);
    const store = createSqlTenantFence({ table: '"fence"', dialect: sqliteDialect }).store(db);
    expect(
      await store.set({ state: "frozen", tenant: "acme", since: "2026-04-01T00:00:00.000Z" }),
    ).toEqual({ state: "frozen", tenant: "acme", since: FROZEN.since });
    expect(statements.filter(([sql]) => !sql.startsWith("SELECT"))).toEqual([]);
    expect(await store.set({ state: "open" })).toEqual({ state: "open" });
    expect(statements.at(-1)).toEqual(['DELETE FROM "fence" WHERE "scope" = ?', ["app"], true]);
  });
});
