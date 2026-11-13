import { describe, expect, it } from "vitest";
import { ProcessingRestrictedError } from "../../contracts/errors.ts";
import { ForgottenSinceLoadError } from "../storage/append-checks.ts";
import type { AppendArgs } from "../storage/event-store.ts";
import { pendingEvent } from "../testing/fixtures.ts";
import { checkSqlAppend } from "./append-checks.ts";
import { postgresqlDialect } from "./dialect.ts";

const append = (names: Pick<AppendArgs, "persons" | "touches" | "seals">): AppendArgs => ({
  aggregateType: "order",
  aggregateId: "1",
  expectedVersion: 0,
  events: [pendingEvent({ aggregateId: "1", version: 1 })],
  ...names,
});

const recording = (rows: Readonly<Record<string, readonly Record<string, unknown>[]>>) => {
  const statements: [string, readonly unknown[]][] = [];
  return {
    statements,
    tx: {
      all: async (statement: string, params: readonly unknown[]) => {
        statements.push([statement, params]);
        return [...(rows[statement.split(" FROM ")[1]?.split(" ")[0] ?? ""] ?? [])];
      },
    },
  };
};

const tables = { personalKeys: "keys", restrictions: "restrictions" };

describe("checkSqlAppend", () => {
  it("reads nothing for an append that names nobody, or names everyone with no key", async () => {
    const { tx, statements } = recording({});
    await checkSqlAppend({ tx, dialect: postgresqlDialect, tables, args: append({}) });
    await checkSqlAppend({
      tx,
      dialect: postgresqlDialect,
      tables,
      args: append({ persons: [{ person: "c-1", fingerprint: null }], touches: [] }),
    });
    expect(statements).toEqual([]);
  });

  it("reads the key rows of the persons named with a key and the restrictions of those sealed under and of those touched, each once, locked when asked", async () => {
    const { tx, statements } = recording({
      keys: [
        { person: "c-1", fingerprint: "f-1", category: "default", retained_since: null },
        { person: "c-2", fingerprint: "f-2", category: "default", retained_since: null },
      ],
    });
    await checkSqlAppend({
      tx,
      dialect: postgresqlDialect,
      tables,
      lock: "FOR SHARE",
      args: append({
        persons: [
          { person: "c-1", fingerprint: "f-1" },
          { person: "c-1", fingerprint: "f-1" },
          { person: "c-4", fingerprint: null },
        ],
        seals: [{ person: "c-2", fingerprint: "f-2" }],
        touches: ["c-3", "c-3"],
      }),
    });
    expect(statements).toEqual([
      [
        `SELECT "person", "fingerprint", "category", "retained_since" FROM keys WHERE "person" IN ($1, $2) FOR SHARE`,
        ["c-1", "c-2"],
      ],
      [
        `SELECT "person", "category" FROM restrictions WHERE "person" IN ($1, $2) FOR SHARE`,
        ["c-3", "c-2"],
      ],
    ]);
  });

  it("refuses on what it read: a person restricted as a whole, a key no longer held, or a key of a restricted category", async () => {
    const { tx, statements } = recording({
      keys: [
        { person: "c-1", fingerprint: "f-new", category: "default", retained_since: null },
        { person: "c-3", fingerprint: "f-3", category: "marketing", retained_since: null },
      ],
      restrictions: [
        { person: "c-2", category: "" },
        { person: "c-3", category: "marketing" },
      ],
    });
    await expect(
      checkSqlAppend({
        tx,
        dialect: postgresqlDialect,
        tables,
        args: append({ touches: ["c-2"] }),
      }),
    ).rejects.toBeInstanceOf(ProcessingRestrictedError);
    await expect(
      checkSqlAppend({
        tx,
        dialect: postgresqlDialect,
        tables,
        args: append({ persons: [{ person: "c-1", fingerprint: "f-old" }] }),
      }),
    ).rejects.toBeInstanceOf(ForgottenSinceLoadError);
    await expect(
      checkSqlAppend({
        tx,
        dialect: postgresqlDialect,
        tables,
        args: append({ persons: [{ person: "c-9", fingerprint: "f-9" }] }),
      }),
    ).rejects.toBeInstanceOf(ForgottenSinceLoadError);
    await expect(
      checkSqlAppend({
        tx,
        dialect: postgresqlDialect,
        tables,
        args: append({ seals: [{ person: "c-3", fingerprint: "f-3" }] }),
      }),
    ).rejects.toBeInstanceOf(ProcessingRestrictedError);
    await expect(
      checkSqlAppend({
        tx,
        dialect: postgresqlDialect,
        tables,
        args: append({ persons: [{ person: "c-3", fingerprint: "f-3" }] }),
      }),
    ).resolves.toBeUndefined();
    expect(statements[0]?.[0]).toBe(
      `SELECT "person", "category" FROM restrictions WHERE "person" IN ($1)`,
    );
  });

  it("refuses a key kept past a forgetting where it was read in force, and lets it through where it was read retained", async () => {
    const { tx } = recording({
      keys: [
        {
          person: "c-1",
          fingerprint: "f-1",
          category: "invoices",
          retained_since: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const check = (retained: boolean) =>
      checkSqlAppend({
        tx,
        dialect: postgresqlDialect,
        tables,
        args: append({
          persons: [
            retained
              ? { person: "c-1", fingerprint: "f-1", retained: true }
              : { person: "c-1", fingerprint: "f-1" },
          ],
        }),
      });
    await expect(check(false)).rejects.toBeInstanceOf(ForgottenSinceLoadError);
    await expect(check(true)).resolves.toBeUndefined();
  });

  it("locks the rows of the persons whose restrictions it reads when asked, and reads no such row otherwise", async () => {
    const { tx, statements } = recording({});
    const args = append({ touches: ["c-1"] });
    await checkSqlAppend({
      tx,
      dialect: postgresqlDialect,
      tables: { ...tables, persons: "persons" },
      args,
      lock: "FOR SHARE",
    });
    await checkSqlAppend({
      tx,
      dialect: postgresqlDialect,
      tables: { ...tables, persons: "persons" },
      args,
    });
    expect(statements.map(([statement]) => statement)).toEqual([
      `SELECT "person", "category" FROM restrictions WHERE "person" IN ($1) FOR SHARE`,
      `SELECT "person" FROM persons WHERE "person" IN ($1) FOR SHARE`,
      `SELECT "person", "category" FROM restrictions WHERE "person" IN ($1)`,
    ]);
  });
});
