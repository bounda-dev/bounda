import { describe, expect, it } from "vitest";
import { ProcessingRestrictedError } from "../../contracts/errors.ts";
import { ForgottenSinceLoadError } from "../storage/append-checks.ts";
import type { AppendArgs } from "../storage/event-store.ts";
import { pendingEvent } from "../testing/fixtures.ts";
import { checkSqlAppend } from "./append-checks.ts";
import { postgresqlDialect } from "./dialect.ts";

const append = (names: Pick<AppendArgs, "persons" | "touches">): AppendArgs => ({
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

const tables = { personalKeys: "keys", persons: "persons" };

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

  it("reads the key rows of the persons named with a key and the rows of those touched, each once, locked when asked", async () => {
    const { tx, statements } = recording({
      keys: [
        { person: "c-1", fingerprint: "f-1" },
        { person: "c-2", fingerprint: "f-2" },
      ],
      persons: [{ person: "c-3", restricted_since: null }],
    });
    await checkSqlAppend({
      tx,
      dialect: postgresqlDialect,
      tables,
      lock: "FOR SHARE",
      args: append({
        persons: [
          { person: "c-1", fingerprint: "f-1" },
          { person: "c-2", fingerprint: "f-2" },
          { person: "c-1", fingerprint: "f-1" },
          { person: "c-4", fingerprint: null },
        ],
        touches: ["c-3", "c-3"],
      }),
    });
    expect(statements).toEqual([
      [
        `SELECT "person", "fingerprint" FROM keys WHERE "person" IN ($1, $2) FOR SHARE`,
        ["c-1", "c-2"],
      ],
      [
        `SELECT "person", "restricted_since" FROM persons WHERE "person" IN ($1) FOR SHARE`,
        ["c-3"],
      ],
    ]);
  });

  it("refuses on what it read: a restricted person, or a key no longer held", async () => {
    const { tx, statements } = recording({
      keys: [{ person: "c-1", fingerprint: "f-new" }],
      persons: [{ person: "c-2", restricted_since: "2026-01-01T00:00:00.000Z" }],
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
    expect(statements[0]?.[0]).toBe(
      `SELECT "person", "restricted_since" FROM persons WHERE "person" IN ($1)`,
    );
  });
});
