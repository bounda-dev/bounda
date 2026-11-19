import { existsSync } from "node:fs";
import { ConfigurationError } from "@bounda-dev/core";
import type { SqliteCopy } from "@bounda-dev/core/adapter/sqlite";
import { type Client, createClient, type InValue } from "@libsql/client";

const isNotADatabase = (error: unknown): boolean =>
  error instanceof Error && Reflect.get(error, "code") === "SQLITE_NOTADB";

// Integers read as they are stored, past what a number holds exactly.
const openUnder = async (copy: string, key: string | null): Promise<Client | null> => {
  const client = createClient({
    url: `file:${copy}`,
    intMode: "bigint",
    ...(key === null ? {} : { encryptionKey: key }),
  });
  try {
    await client.execute("SELECT count(*) FROM sqlite_master");
    return client;
  } catch (error) {
    client.close();
    if (isNotADatabase(error)) return null;
    throw error;
  }
};

export interface OpenLibsqlCopyArgs {
  readonly copy: string;
  /**
   * The keys the copy may be encrypted under, in the order to try them, `null` for none.
   */
  readonly keys: readonly (string | null)[];
}

export interface OpenLibsqlCopyFunction {
  (args: OpenLibsqlCopyArgs): Promise<SqliteCopy>;
}

/**
 * A copy of a libSQL file for `restore` to read, under the first of `keys` it opens under.
 */
export const openLibsqlCopy: OpenLibsqlCopyFunction = async ({ copy, keys }) => {
  // libSQL would create an empty database where there is none.
  if (!existsSync(copy)) throw new ConfigurationError(`There is no copy at ${copy}`);
  for (const key of keys) {
    const client = await openUnder(copy, key);
    if (client === null) continue;
    return {
      db: {
        all: async (sql, params) => {
          const result = await client.execute({ sql, args: params as InValue[] });
          return result.rows.map((row) =>
            Object.fromEntries(result.columns.map((column, index) => [column, row[index] ?? null])),
          );
        },
      },
      close: async () => client.close(),
    };
  }
  throw new ConfigurationError(
    `The copy at ${copy} opens under none of its tenant's keys: it is another tenant's, or not a database`,
  );
};
