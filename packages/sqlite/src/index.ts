import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Adapter, EncryptedFile, FileKey, FileKeyAccess } from "@bounda-dev/core/adapter";
import {
  DEFAULT_TABLE_PREFIX,
  quoteIdentifier,
  storageTableNameFor,
} from "@bounda-dev/core/adapter/sql";
import { createSqliteAdapter, SQLITE_BUSY_TIMEOUT_MS } from "@bounda-dev/core/adapter/sqlite";
import { type Client, createClient } from "@libsql/client";
import { closeConnectionsOnce } from "./close-once.ts";
import { openLibsqlCopy } from "./copy.ts";
import { createSqliteDatabase, type LibsqlConnection } from "./database.ts";
import { fileEncryptionOf, prepareFile } from "./encryption.ts";
import { resolveSqliteOptions, type SqliteOptions } from "./options.ts";

/**
 * The adapter `sqlite(...)` returns: what `bounda.config.ts` holds under `storage` or
 * `readModels`.
 */
export type SqliteAdapter = Adapter<"sqlite", SqliteOptions>;

export interface SqliteFunction {
  (options: SqliteOptions): SqliteAdapter;
}

interface Connection extends LibsqlConnection {
  readonly client: Client;
  uses: number;
}

// The file an adapter opened through the tenant's keys, and the encryption it still awaits.
interface Keyed {
  readonly path: string;
  readonly keys: FileKeyAccess;
  readonly under: FileKey | null;
  readonly inForce: FileKey;
  /**
   * The connection the file was opened on, which the adapter takes as its first.
   */
  readonly client: Client;
}

// The adapter over the database `options` name, opened under `encryptionKey` when given, and
// through the tenant's keys when `keyed` says so.
const libsqlAdapter = (
  options: SqliteOptions,
  opening: string | undefined,
  keyed: Keyed | null = null,
): SqliteAdapter => {
  let encryptionKey = opening;
  let handed: Client | null = keyed?.client ?? null;
  const { url, authToken, tablePrefix, medium } = resolveSqliteOptions(options);
  if (medium !== "remote") closeConnectionsOnce();
  let connection: Connection | null = null;

  const open = (): Connection => {
    if (connection === null) {
      if ("path" in options) mkdirSync(dirname(options.path), { recursive: true });
      const client =
        handed ??
        createClient({
          url,
          ...(authToken === undefined ? {} : { authToken }),
          ...(medium === "file" ? { timeout: SQLITE_BUSY_TIMEOUT_MS } : {}),
          ...(encryptionKey === undefined ? {} : { encryptionKey }),
        });
      handed = null;
      const opened = createSqliteDatabase(client, {
        local: medium !== "remote",
        wal: medium === "file",
      });
      connection = { ...opened, client, uses: 0 };
    }
    connection.uses += 1;
    return connection;
  };

  // The client closes once what it runs has settled, unless it was handed out again meanwhile.
  const release = async (): Promise<void> => {
    const releasing = connection;
    if (releasing === null) return;
    releasing.uses -= 1;
    if (releasing.uses > 0) return;
    await releasing.settled();
    if (releasing.uses > 0 || connection !== releasing) return;
    releasing.client.close();
    connection = null;
  };

  return createSqliteAdapter({
    name: "sqlite",
    options,
    ...(options.location === undefined ? {} : { location: options.location }),
    tablePrefix,
    acquire: () => {
      const { db, raw } = open();
      return { db, raw };
    },
    release,
    ephemeral: medium === "memory",
    ...("path" in options && options.encrypt !== false && keyed === null
      ? { encryptedFile: encryptedFileAt(options) }
      : {}),
    // A copy of a file the tenant's keys encrypt is under the key in force when it was taken.
    ...(medium === "file"
      ? {
          openCopy: async (copy: string) =>
            openLibsqlCopy({
              copy,
              // A file in the clear has no key; one under the tenant's keys was opened under the key
              // in force, and a copy may be under an earlier one, or from before it was encrypted.
              keys:
                keyed === null
                  ? [null]
                  : [
                      keyed.inForce.key,
                      ...(await keyed.keys.previous()).map(({ key }) => key),
                      null,
                    ],
            }),
        }
      : {}),
    ...(keyed === null
      ? {}
      : {
          fileEncryption: fileEncryptionOf({
            path: keyed.path,
            database: databaseOf(keyed.path),
            keys: keyed.keys,
            under: keyed.under,
            inForce: keyed.inForce,
            // Through the adapter's own connection, the one left on the file once the app runs.
            alone: async (task) => {
              const { client, alone } = open();
              try {
                return await alone(() => task(client));
              } finally {
                await release();
              }
            },
            encrypted: (key) => {
              encryptionKey = key;
            },
          }),
        }),
  });
};

// The name the tenant's record keeps a file's keys under: its path as given, with `/`.
const databaseOf = (path: string): string => path.replaceAll("\\", "/");

const encryptedFileAt = (options: SqliteOptions & { readonly path: string }): EncryptedFile => ({
  database: databaseOf(options.path),
  open: async ({ keys, logger }) => {
    mkdirSync(dirname(options.path), { recursive: true });
    const prepared = await prepareFile({
      path: options.path,
      keys,
      logger,
      tenancy: quoteIdentifier(
        storageTableNameFor({
          prefix: options.tablePrefix ?? DEFAULT_TABLE_PREFIX,
          table: "tenancy",
        }),
      ),
    });
    // The tenant's file keys are gone: the file opens no more, and the app runs on nothing.
    if ("gone" in prepared) {
      return libsqlAdapter(
        {
          memory: true,
          ...(options.tablePrefix === undefined ? {} : { tablePrefix: options.tablePrefix }),
        },
        undefined,
      );
    }
    return libsqlAdapter(options, prepared.under?.key, {
      path: options.path,
      keys,
      under: prepared.under,
      inForce: prepared.inForce,
      client: prepared.client,
    });
  },
});

/**
 * SQLite storage through libSQL: a local file (`{ path }`, its directory is created), memory
 * (`{ memory: true }`) or a libSQL server such as Turso (`{ url, authToken }`). Storage and read
 * models opened from the same adapter share one connection, closed when the last of them closes.
 * A file is kept in WAL mode, and a statement on it waits a few seconds for another process's
 * write before failing. In an app with a key wrapper and a tenant key store, a file is encrypted
 * under a key of its tenant's own unless `encrypt: false`: one in the clear is encrypted when the
 * app starts with the file to itself, and from then on only the app, or a tool that reads the
 * tenant's keys as `withEncryptedFiles` does, opens it.
 */
export const sqlite: SqliteFunction = (options) => libsqlAdapter(options, undefined);

export type { SqliteOptions } from "./options.ts";
