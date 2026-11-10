import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { restoreContract } from "@bounda-dev/core/adapter/testing";
import { defineForgetLedger } from "@bounda-dev/core/config";
import { describe } from "vitest";
import { durableObjectAdapter } from "../src/adapter.ts";
import { createKvForgetLedger } from "../src/forget-ledger.ts";
import { insideObject } from "./inside-object.ts";

interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string;
}

interface Copy {
  readonly schema: readonly SchemaObject[];
  readonly rows: Readonly<Record<string, readonly Record<string, SqlStorageValue>[]>>;
}

// Everything the app keeps in the object's SQLite database; workerd's own tables stay.
const schemaOf = (sql: SqlStorage): SchemaObject[] =>
  sql
    .exec<{ type: string; name: string; sql: string | null }>(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    )
    .toArray()
    .flatMap(({ type, name, sql: text }) => (text === null ? [] : [{ type, name, sql: text }]));

const tablesOf = (schema: readonly SchemaObject[]): readonly string[] =>
  schema.filter(({ type }) => type === "table").map(({ name }) => name);

const copyOf = (sql: SqlStorage): Copy => {
  const schema = schemaOf(sql);
  return {
    schema,
    rows: Object.fromEntries(
      tablesOf(schema).map((table) => [table, sql.exec(`SELECT * FROM "${table}"`).toArray()]),
    ),
  };
};

// Workerd keeps no point-in-time history of an object's storage, which Cloudflare restores to a
// bookmark and then restarts the object: the copy is every table, index and trigger with its rows,
// and restoring puts back exactly those, in one transaction.
const restoreFrom = (storage: DurableObjectStorage, copy: Copy): void => {
  storage.transactionSync(() => {
    for (const table of tablesOf(schemaOf(storage.sql))) storage.sql.exec(`DROP TABLE "${table}"`);
    for (const { sql: text } of copy.schema.filter(({ type }) => type === "table")) {
      storage.sql.exec(text);
    }
    for (const [table, rows] of Object.entries(copy.rows)) {
      for (const row of rows) {
        const columns = Object.keys(row);
        storage.sql.exec(
          `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          ...columns.map((column) => row[column] ?? null),
        );
      }
    }
    // After the rows, so no trigger writes what the copy already holds.
    for (const { sql: text } of copy.schema.filter(({ type }) => type !== "table")) {
      storage.sql.exec(text);
    }
  });
};

let objects = 0;

describe("restoring a Durable Object's storage", () => {
  restoreContract({
    hot: false,
    create: async () => {
      objects += 1;
      const stub = env.BARE.get(env.BARE.newUniqueId());
      const adapter = insideObject(
        stub,
        await runInDurableObject(stub, (_instance, state) =>
          durableObjectAdapter({ storage: state.storage, options: {} }),
        ),
      );
      let copy: Copy | null = null;
      return {
        storage: adapter,
        // KV, as on Cloudflare: a restore of the object leaves it alone.
        forgetLedger: defineForgetLedger(() =>
          createKvForgetLedger({ namespace: env.FORGET_LEDGER, prefix: `restore-${objects}/` }),
        ),
        backUp: async () => {
          copy = await runInDurableObject(stub, (_instance, state) => copyOf(state.storage.sql));
        },
        restore: async () => {
          const taken = copy;
          if (taken === null) throw new Error("no copy was taken");
          await runInDurableObject(stub, (_instance, state) => restoreFrom(state.storage, taken));
          return adapter;
        },
      };
    },
  });
});
