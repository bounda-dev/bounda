import { describe, expect, it } from "vitest";
import { postgresqlDialect, sqliteDialect } from "./dialect.ts";
import { createSqlForgetLedger, forgetLedgerStatements } from "./forget-ledger.ts";

const recording = () => {
  const statements: (readonly [string, readonly unknown[]])[] = [];
  const db = {
    run: async (sql: string, params: readonly unknown[]) => {
      statements.push([sql, params]);
    },
    all: async (sql: string, params: readonly unknown[]) => {
      statements.push([sql, params]);
      return [];
    },
  };
  return { db, statements };
};

const entry = (index: number) => ({
  personId: `c-${index}`,
  eventId: `e-${index}`,
  forgottenAt: "2026-01-01T00:00:00.000Z",
});

describe("the SQL forget ledger", () => {
  it("orders by code unit in PostgreSQL, as SQLite does by default", () => {
    const [postgresTable] = forgetLedgerStatements(`"t_forget_ledger"`, postgresqlDialect);
    expect(postgresTable).toContain(`"event_id" TEXT COLLATE "C" NOT NULL`);
    expect(postgresTable).toContain(`"forgotten_at" TEXT COLLATE "C" NOT NULL`);
    const [sqliteTable, index] = forgetLedgerStatements(`"t_forget_ledger"`, sqliteDialect);
    expect(sqliteTable).not.toContain("COLLATE");
    expect(index).toBe(
      `CREATE INDEX IF NOT EXISTS "t_forget_ledger_order_idx" ON "t_forget_ledger" ("tenant", "forgotten_at", "event_id")`,
    );
  });

  it("inserts at most 25 entries a statement, each bound to its own numbered parameters", async () => {
    const { db, statements } = recording();
    const ledger = createSqlForgetLedger({
      db,
      table: `"t"`,
      dialect: postgresqlDialect,
      tenant: undefined,
      ensureSchema: async () => {},
      close: async () => {},
    });
    await ledger.append(Array.from({ length: 26 }, (_, index) => entry(index)));
    expect(statements).toHaveLength(2);
    const [first, second] = statements;
    expect(first?.[0]).toContain("($1, $2, $3, $4), ($5, $6, $7, $8)");
    expect(first?.[0]).toContain("($97, $98, $99, $100) ON CONFLICT");
    expect(first?.[1]).toHaveLength(100);
    expect(first?.[1].slice(0, 4)).toEqual(["", "e-0", "c-0", "2026-01-01T00:00:00.000Z"]);
    expect(second?.[0]).toContain(`VALUES ($1, $2, $3, $4) ON CONFLICT`);
    expect(second?.[1]).toEqual(["", "e-25", "c-25", "2026-01-01T00:00:00.000Z"]);
  });

  it("creates its table before the first statement, and again after that failed", async () => {
    const { db, statements } = recording();
    let attempts = 0;
    const ledger = createSqlForgetLedger({
      db,
      table: `"t"`,
      dialect: postgresqlDialect,
      tenant: "t-1",
      ensureSchema: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("database is down");
      },
      close: async () => {},
    });
    await expect(ledger.read({ limit: 1 })).rejects.toThrow("database is down");
    expect(statements).toEqual([]);
    await ledger.read({ limit: 1 });
    await ledger.append([entry(1)]);
    expect(attempts).toBe(2);
    expect(statements.map(([, params]) => params[0])).toEqual(["t-1", "t-1"]);
  });
});
