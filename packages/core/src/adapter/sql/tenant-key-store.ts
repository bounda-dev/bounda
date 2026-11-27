import type {
  PendingRecipientDeclaration,
  StoredFileKey,
  StoredTenantKey,
  TenantForgetting,
  TenantKeyRecord,
  TenantKeyStore,
  VersionedTenantKeyRecord,
} from "../storage/tenant-key-store.ts";
import type { SqlDialect } from "./dialect.ts";
import type { SqlExecutor } from "./sql-table.ts";

export interface TenantKeysTableStatementFunction {
  (table: string): string;
}

/**
 * The tenant key store's table, `table` already quoted: the first migration of its scope. The
 * record is JSON, so a version of Bounda that keeps more of a tenant adds no column.
 */
export const tenantKeysTableStatement: TenantKeysTableStatementFunction = (table) =>
  `CREATE TABLE IF NOT EXISTS ${table} (
    "tenant" TEXT NOT NULL PRIMARY KEY,
    "revision" BIGINT NOT NULL,
    "record" TEXT NOT NULL
  )`;

export interface CreateSqlTenantKeyStoreArgs {
  readonly db: SqlExecutor;
  /**
   * Already quoted.
   */
  readonly table: string;
  readonly dialect: Pick<SqlDialect, "placeholder">;
  /**
   * Creates or migrates the table, run before the first call that touches it.
   */
  readonly ensureSchema: () => Promise<unknown>;
  readonly close: () => Promise<void>;
}

export interface CreateSqlTenantKeyStoreFunction {
  (args: CreateSqlTenantKeyStoreArgs): TenantKeyStore;
}

const textOf = (value: unknown, field: string): string => {
  if (typeof value !== "string") {
    throw new Error(`A tenant key record holds no text in ${field}`);
  }
  return value;
};

const storedKeyOf = (value: unknown): StoredTenantKey => {
  const key = value as Record<string, unknown>;
  return {
    kid: textOf(key.kid, "kid"),
    fingerprint: textOf(key.fingerprint, "fingerprint"),
    key: textOf(key.key, "key"),
    wrappedBy: textOf(key.wrappedBy, "wrappedBy"),
    createdAt: textOf(key.createdAt, "createdAt"),
  };
};

const fileKeyOf = (value: unknown): StoredFileKey => {
  const key = value as Record<string, unknown>;
  return {
    database: textOf(key.database, "database"),
    id: textOf(key.id, "id"),
    key: textOf(key.key, "key"),
    wrappedBy: textOf(key.wrappedBy, "wrappedBy"),
    createdAt: textOf(key.createdAt, "createdAt"),
    ...(key.appliedAt === undefined ? {} : { appliedAt: textOf(key.appliedAt, "appliedAt") }),
  };
};

const filesOf = (value: unknown): { readonly files?: readonly StoredFileKey[] } => {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw new Error("A tenant key record holds no list in files");
  return { files: value.map(fileKeyOf) };
};

const forgettingOf = (value: unknown): TenantForgetting | null => {
  if (value === null || value === undefined) return null;
  const forgetting = value as Record<string, unknown>;
  return {
    at: textOf(forgetting.at, "at"),
    eventId: textOf(forgetting.eventId, "eventId"),
    ...filesOf(forgetting.files),
  };
};

const listOf = (value: unknown, field: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`A tenant key record holds no list in ${field}`);
  return value;
};

const pendingDeclarationOf = (value: unknown): PendingRecipientDeclaration => {
  const declaration = value as Record<string, unknown>;
  if (typeof declaration.position !== "number") {
    throw new Error("A tenant key record holds no number in position");
  }
  return {
    id: textOf(declaration.id, "id"),
    renames: listOf(declaration.renames, "renames").map((rename) => {
      const { from, to } = rename as Record<string, unknown>;
      return { from: textOf(from, "from"), to: textOf(to, "to") };
    }),
    ports: listOf(declaration.ports, "ports").map((declared) => {
      const { port, categories } = declared as Record<string, unknown>;
      return {
        port: textOf(port, "port"),
        categories: listOf(categories, "categories").map((name) => textOf(name, "categories")),
      };
    }),
    position: declaration.position,
    at: textOf(declaration.at, "at"),
  };
};

const pendingRecipientsOf = (
  value: unknown,
): { readonly pendingRecipients?: readonly PendingRecipientDeclaration[] } =>
  value === undefined
    ? {}
    : { pendingRecipients: listOf(value, "pendingRecipients").map(pendingDeclarationOf) };

const pendingDeclarationText = ({
  id,
  renames,
  ports,
  position,
  at,
}: PendingRecipientDeclaration) => ({
  id,
  renames: renames.map(({ from, to }) => ({ from, to })),
  ports: ports.map(({ port, categories }) => ({ port, categories: [...categories] })),
  position,
  at,
});

export interface ParseTenantKeyRecordFunction {
  (text: string, revision: number): VersionedTenantKeyRecord;
}

/**
 * A record as a store kept it in JSON, checked field by field: what is read is never trusted to
 * have the shape it was written with.
 */
export const parseTenantKeyRecord: ParseTenantKeyRecordFunction = (text, revision) => {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (!Array.isArray(parsed.keys)) throw new Error("A tenant key record holds no keys");
  return {
    revision,
    store: textOf(parsed.store, "store"),
    keys: parsed.keys.map(storedKeyOf),
    forgotten: forgettingOf(parsed.forgotten),
    ...filesOf(parsed.files),
    ...(typeof parsed.frozenAt === "string" ? { frozenAt: parsed.frozenAt } : {}),
    ...pendingRecipientsOf(parsed.pendingRecipients),
  };
};

export interface TenantKeyRecordTextFunction {
  (record: TenantKeyRecord): string;
}

const fileKeyText = ({ database, id, key, wrappedBy, createdAt, appliedAt }: StoredFileKey) => ({
  database,
  id,
  key,
  wrappedBy,
  createdAt,
  ...(appliedAt === undefined ? {} : { appliedAt }),
});

export const tenantKeyRecordText: TenantKeyRecordTextFunction = ({
  store,
  keys,
  forgotten,
  files,
  frozenAt,
  pendingRecipients,
}) =>
  JSON.stringify({
    store,
    keys: keys.map(({ kid, fingerprint, key, wrappedBy, createdAt }) => ({
      kid,
      fingerprint,
      key,
      wrappedBy,
      createdAt,
    })),
    forgotten:
      forgotten === null
        ? null
        : {
            at: forgotten.at,
            eventId: forgotten.eventId,
            ...(forgotten.files === undefined ? {} : { files: forgotten.files.map(fileKeyText) }),
          },
    ...(files === undefined ? {} : { files: files.map(fileKeyText) }),
    ...(frozenAt === undefined ? {} : { frozenAt }),
    ...(pendingRecipients === undefined
      ? {}
      : { pendingRecipients: pendingRecipients.map(pendingDeclarationText) }),
  });

/**
 * `TenantKeyStore` on the SQL SQLite and PostgreSQL both speak, in a database other than any
 * tenant's: `put` compares the revision and sets the record in one statement.
 */
export const createSqlTenantKeyStore: CreateSqlTenantKeyStoreFunction = ({
  db,
  table,
  dialect,
  ensureSchema,
  close,
}) => {
  const p = dialect.placeholder;
  let ready: Promise<unknown> | null = null;
  const schema = (): Promise<unknown> => {
    ready ??= ensureSchema().catch((error: unknown) => {
      ready = null;
      throw error;
    });
    return ready;
  };
  return {
    get: async (tenant) => {
      await schema();
      const [row] = await db.all(
        `SELECT "revision", "record" FROM ${table} WHERE "tenant" = ${p(1)}`,
        [tenant],
      );
      return row === undefined
        ? null
        : parseTenantKeyRecord(textOf(row.record, "record"), Number(row.revision));
    },
    list: async ({ cursor, limit }) => {
      await schema();
      const rows =
        cursor === null
          ? await db.all(
              `SELECT "tenant" FROM ${table} ORDER BY "tenant" LIMIT ${Math.trunc(limit)}`,
              [],
            )
          : await db.all(
              `SELECT "tenant" FROM ${table} WHERE "tenant" > ${p(1)} ORDER BY "tenant" LIMIT ${Math.trunc(limit)}`,
              [cursor],
            );
      const tenants = rows.map((row) => textOf(row.tenant, "tenant"));
      return { tenants, cursor: tenants.length < limit ? null : (tenants.at(-1) ?? null) };
    },
    put: async (tenant, record, expected) => {
      await schema();
      const text = tenantKeyRecordText(record);
      const written =
        expected === null
          ? await db.all(
              `INSERT INTO ${table} ("tenant", "revision", "record") VALUES (${p(1)}, 1, ${p(2)}) ON CONFLICT ("tenant") DO NOTHING RETURNING "tenant"`,
              [tenant, text],
            )
          : await db.all(
              `UPDATE ${table} SET "revision" = "revision" + 1, "record" = ${p(1)} WHERE "tenant" = ${p(2)} AND "revision" = ${p(3)} RETURNING "tenant"`,
              [text, tenant, expected],
            );
      return written.length === 1;
    },
    remove: async (tenant, expected) => {
      await schema();
      const removed = await db.all(
        `DELETE FROM ${table} WHERE "tenant" = ${p(1)} AND "revision" = ${p(2)} RETURNING "tenant"`,
        [tenant, expected],
      );
      return removed.length === 1;
    },
    close,
  };
};
