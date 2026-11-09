import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreContract } from "@bounda-dev/core/adapter/testing";
import { type Client, createClient } from "@libsql/client";
import { afterAll, beforeAll, describe } from "vitest";
import { sqlite } from "./index.ts";

let directory: string;
let files = 0;
const clients: Client[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bounda-restore-"));
});

afterAll(async () => {
  for (const client of clients) client.close();
  // libSQL lets go of a file that saw a write transaction only once its statements are garbage
  // collected, and Windows cannot delete a file still open: there, those stay behind in the
  // temporary directory.
  await rm(directory, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
    if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
  });
});

const fresh = (name: string): string => {
  files += 1;
  return join(directory, `${name}-${files}.db`);
};

const clientOf = (path: string): Client => {
  const client = createClient({ url: `file:${path}` });
  clients.push(client);
  return client;
};

interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

const schemaOf = async (client: Client): Promise<readonly SchemaObject[]> =>
  (
    await client.execute("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
  ).rows.map(({ type, name, sql }) => ({
    type: String(type),
    name: String(name),
    sql: sql === null ? null : String(sql),
  }));

// In place, in one write transaction through the app's own engine, as pg_restore --clean
// --single-transaction does: the app's connections see the database before the restore or after
// it, never in between. Every table, index and trigger goes, and the copy's come back with its rows.
const restoreInPlace = async (client: Client, copy: string): Promise<void> => {
  const source = clientOf(copy);
  const copied = await schemaOf(source);
  const tables = copied.filter(({ type }) => type === "table");
  const rows = await Promise.all(
    tables.map(async ({ name }) => ({
      name,
      rows: (await source.execute(`SELECT * FROM "${name}"`)).rows,
    })),
  );
  const live = (await schemaOf(client)).filter(({ type }) => type === "table");
  await client.batch(
    [
      ...live.map(({ name }) => `DROP TABLE "${name}"`),
      ...tables.flatMap(({ sql }) => (sql === null ? [] : [sql])),
      ...rows.flatMap(({ name, rows: values }) =>
        values.map((row) => {
          const columns = Object.keys(row);
          return {
            sql: `INSERT INTO "${name}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
            args: columns.map((column) => row[column] ?? null),
          };
        }),
      ),
      // After the rows, so no trigger writes what the copy already holds.
      ...copied.flatMap(({ type, sql }) => (type === "table" || sql === null ? [] : [sql])),
    ],
    "write",
  );
};

describe("restoring a libSQL file under a running app", () => {
  restoreContract({
    hot: true,
    create: async () => {
      const path = fresh("store");
      const copy = fresh("backup");
      const client = clientOf(path);
      return {
        storage: sqlite({ path }),
        forgetLedger: sqlite({ path: fresh("ledger") }),
        // An online copy, as a backup tool takes it while the app runs.
        backUp: async () => {
          await client.execute(`VACUUM INTO '${copy}'`);
        },
        restore: async () => {
          await restoreInPlace(client, copy);
          return sqlite({ path });
        },
      };
    },
  });
});

describe("restoring a libSQL file beside the lost one", () => {
  restoreContract({
    hot: false,
    create: async () => {
      let path = fresh("store");
      const copy = fresh("backup");
      return {
        storage: sqlite({ path }),
        forgetLedger: sqlite({ path: fresh("ledger") }),
        backUp: async () => {
          await clientOf(path).execute(`VACUUM INTO '${copy}'`);
        },
        // A copy of the file, beside the old one, which Windows will not let go of while libSQL
        // still holds it.
        restore: async () => {
          path = fresh("restored");
          await copyFile(copy, path);
          return sqlite({ path });
        },
      };
    },
  });
});
