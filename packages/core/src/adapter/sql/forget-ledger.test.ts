import { describe, expect, it } from "vitest";
import type { ForgetLedgerEntry } from "../storage/forget-ledger.ts";
import { postgresqlDialect, sqliteDialect } from "./dialect.ts";
import {
  createSqlForgetLedger,
  forgetLedgerCategoriesStatement,
  forgetLedgerReasonStatements,
  forgetLedgerStatements,
} from "./forget-ledger.ts";

const recording = (rows: readonly Record<string, unknown>[] = []) => {
  const statements: (readonly [string, readonly unknown[]])[] = [];
  const db = {
    run: async (sql: string, params: readonly unknown[]) => {
      statements.push([sql, params]);
    },
    all: async (sql: string, params: readonly unknown[]) => {
      statements.push([sql, params]);
      return rows;
    },
  };
  return { db, statements };
};

const entry = (index: number): ForgetLedgerEntry => ({
  personId: `c-${index}`,
  eventId: `e-${index}`,
  forgottenAt: "2026-01-01T00:00:00.000Z",
  categories: index % 2 === 0 ? null : ["profile"],
  reason: "requested",
  fingerprints: [`k-${index}`],
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

  it("adds the reason, a request for the entries before it, and the keys, none recorded", () => {
    expect(forgetLedgerReasonStatements(`"t"`)).toEqual([
      `ALTER TABLE "t" ADD COLUMN "reason" TEXT NOT NULL DEFAULT 'requested'`,
      `ALTER TABLE "t" ADD COLUMN "fingerprints" TEXT`,
    ]);
  });

  it("adds the categories in a migration of their own, again harmlessly on PostgreSQL", () => {
    expect(forgetLedgerCategoriesStatement(`"t_forget_ledger"`, postgresqlDialect)).toBe(
      `ALTER TABLE "t_forget_ledger" ADD COLUMN IF NOT EXISTS "categories" TEXT`,
    );
    expect(forgetLedgerCategoriesStatement(`"t_forget_ledger"`, sqliteDialect)).toBe(
      `ALTER TABLE "t_forget_ledger" ADD COLUMN "categories" TEXT`,
    );
  });

  it("inserts at most 11 entries a statement, each bound to its own numbered parameters", async () => {
    const { db, statements } = recording();
    const ledger = createSqlForgetLedger({
      db,
      table: `"t"`,
      dialect: postgresqlDialect,
      tenant: undefined,
      ensureSchema: async () => {},
      close: async () => {},
    });
    const { fingerprints: _, ...unrecorded } = entry(11);
    const redaction = {
      events: [
        { id: "e-0", aggregateType: "c", aggregateId: "c-12", type: "T", fields: ["email"] },
      ],
    };
    await ledger.append([
      ...Array.from({ length: 11 }, (_, index) => entry(index)),
      {
        ...unrecorded,
        reason: "retention",
        restriction: {
          type: "ProcessingRestrictionLifted",
          payload: {
            personId: "c-11",
            grounds: ["legal-claims"],
            categories: null,
            restrictions: [],
          },
        },
      },
      { ...entry(12), redaction },
    ]);
    expect(statements).toHaveLength(2);
    const [first, second] = statements;
    expect(first?.[0]).toContain(
      `INSERT INTO "t" ("tenant", "event_id", "person", "forgotten_at", "reason", "fingerprints", "categories", "restriction", "redaction") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9), ($10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    );
    expect(first?.[0]).toContain("($91, $92, $93, $94, $95, $96, $97, $98, $99) ON CONFLICT");
    expect(first?.[1]).toHaveLength(99);
    expect(first?.[1].slice(0, 18)).toEqual([
      "",
      "e-0",
      "c-0",
      "2026-01-01T00:00:00.000Z",
      "requested",
      `["k-0"]`,
      null,
      null,
      null,
      "",
      "e-1",
      "c-1",
      "2026-01-01T00:00:00.000Z",
      "requested",
      `["k-1"]`,
      `["profile"]`,
      null,
      null,
    ]);
    expect(second?.[0]).toContain(
      `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9), ($10, $11, $12, $13, $14, $15, $16, $17, $18) ON CONFLICT`,
    );
    expect(second?.[1]).toEqual([
      "",
      "e-11",
      "c-11",
      "2026-01-01T00:00:00.000Z",
      "retention",
      null,
      `["profile"]`,
      JSON.stringify({
        type: "ProcessingRestrictionLifted",
        payload: {
          personId: "c-11",
          grounds: ["legal-claims"],
          categories: null,
          restrictions: [],
        },
      }),
      null,
      "",
      "e-12",
      "c-12",
      "2026-01-01T00:00:00.000Z",
      "requested",
      `["k-12"]`,
      null,
      null,
      JSON.stringify(redaction),
    ]);
  });

  it("reads the categories of an entry back, null for a forgetting of the person as a whole", async () => {
    const { db } = recording([
      {
        event_id: "e-0",
        person: "c-0",
        forgotten_at: "2026-01-01T00:00:00.000Z",
        reason: "requested",
        fingerprints: `["k-0"]`,
        categories: null,
      },
      {
        event_id: "e-1",
        person: "c-1",
        forgotten_at: "2026-01-01T00:00:00.000Z",
        reason: "requested",
        fingerprints: `["k-1"]`,
        categories: `["profile"]`,
      },
    ]);
    const ledger = createSqlForgetLedger({
      db,
      table: `"t"`,
      dialect: sqliteDialect,
      tenant: undefined,
      ensureSchema: async () => {},
      close: async () => {},
    });
    expect(await ledger.read({ limit: 2 })).toEqual([entry(0), entry(1)]);
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
