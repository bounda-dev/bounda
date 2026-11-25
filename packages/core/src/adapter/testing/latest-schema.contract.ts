import { describe, expect, it } from "vitest";
import type { SchemaScopeName } from "../adapter.ts";
import type { SqlDatabase } from "../sql/database.ts";
import { schemaMigrationsTableFor } from "../sql/migrations.ts";
import { replaySqlite, sqliteSchemaScopesFor } from "../sqlite/migrations.ts";
import { canonicalSql } from "./canonical-sql.ts";
import type { StorageSchemaTarget } from "./storage-schema.contract.ts";

/**
 * A database for one case, as `storageSchemaContract` takes it, that also brings every scope under
 * `prefix` to its latest version one migration at a time, as it would a database an earlier version
 * of Bounda left behind.
 */
export interface LatestSchemaTarget extends StorageSchemaTarget {
  readonly replay: () => Promise<void>;
}

export interface LatestSchemaContractArgs {
  // A new database, or a new prefix in one, on every call.
  readonly create: () => Promise<LatestSchemaTarget>;
  readonly dialect: "sqlite" | "postgresql";
}

export interface LatestSchemaContractFunction {
  (args: LatestSchemaContractArgs): void;
}

const SCOPES: readonly SchemaScopeName[] = [
  "storage",
  "checkpoints",
  "forget-ledger",
  "tenant-keys",
];

type Row = Readonly<Record<string, unknown>>;

const listed = (rows: readonly Row[], local: (text: unknown) => string): readonly string[] =>
  rows.map((row) => Object.values(row).map(local).join(" | "));

/**
 * Everything the engine keeps of the tables under a prefix, the prefix taken out of every name so
 * two prefixes compare. SQLite keeps each table, index and trigger as the text that defines it,
 * spacing aside; PostgreSQL as its catalogs describe it, a table's columns in the order a query
 * sees them.
 */
const schemaOf = async (
  { execute, prefix }: StorageSchemaTarget,
  dialect: LatestSchemaContractArgs["dialect"],
): Promise<readonly string[]> => {
  const local = (text: unknown): string =>
    text === null ? "null" : String(text).replaceAll(prefix, "<prefix>");
  const ours = (column: string): string => `substr(${column}, 1, ${prefix.length}) = '${prefix}'`;
  if (dialect === "sqlite") {
    const objects = await execute(
      `SELECT "type", "name", "tbl_name", "sql" FROM sqlite_master WHERE ${ours('"tbl_name"')}`,
    );
    return objects
      .map(
        ({ type, name, tbl_name, sql }) =>
          `${String(type)} ${local(name)} on ${local(tbl_name)}: ${typeof sql === "string" ? canonicalSql(local(sql)) : "null"}`,
      )
      .sort();
  }
  const tables = `SELECT "c"."oid" FROM pg_class AS "c" WHERE "c"."relnamespace" = current_schema()::regnamespace AND ${ours('"c"."relname"')}`;
  const sections = await Promise.all([
    execute(
      `SELECT 'relation', "relname", "relkind", "relpersistence", "relrowsecurity", "relforcerowsecurity", coalesce(array_to_string("reloptions", ','), ''), coalesce(obj_description("oid", 'pg_class'), '') FROM pg_class WHERE "relnamespace" = current_schema()::regnamespace AND ${ours('"relname"')}`,
    ),
    execute(
      `SELECT 'column', "c"."relname", row_number() OVER (PARTITION BY "c"."relname" ORDER BY "a"."attnum"), "a"."attname", format_type("a"."atttypid", "a"."atttypmod"), "a"."attnotnull", coalesce(pg_get_expr("d"."adbin", "d"."adrelid"), ''), coalesce("co"."collname", ''), "a"."attidentity", "a"."attgenerated", "a"."attstorage", coalesce(col_description("c"."oid", "a"."attnum"), '') FROM pg_attribute AS "a" JOIN pg_class AS "c" ON "c"."oid" = "a"."attrelid" LEFT JOIN pg_attrdef AS "d" ON "d"."adrelid" = "a"."attrelid" AND "d"."adnum" = "a"."attnum" LEFT JOIN pg_collation AS "co" ON "co"."oid" = "a"."attcollation" WHERE "c"."oid" IN (${tables}) AND "c"."relkind" = 'r' AND "a"."attnum" > 0 AND NOT "a"."attisdropped"`,
    ),
    execute(
      `SELECT 'constraint', "conrelid"::regclass::text, "conname", "contype", "condeferrable", "condeferred", pg_get_constraintdef("oid") FROM pg_constraint WHERE "conrelid" IN (${tables})`,
    ),
    execute(
      `SELECT 'index', "indexname", "indexdef" FROM pg_indexes WHERE "schemaname" = current_schema() AND ${ours('"tablename"')}`,
    ),
    execute(
      `SELECT 'sequence', "s"."relname", format_type("q"."seqtypid", NULL), "q"."seqstart", "q"."seqincrement", "q"."seqmin", "q"."seqmax", "q"."seqcache", "q"."seqcycle", coalesce("d"."refobjid"::regclass::text || '.' || "a"."attname", '') FROM pg_sequence AS "q" JOIN pg_class AS "s" ON "s"."oid" = "q"."seqrelid" LEFT JOIN pg_depend AS "d" ON "d"."objid" = "s"."oid" AND "d"."classid" = 'pg_class'::regclass AND "d"."refclassid" = 'pg_class'::regclass AND "d"."deptype" IN ('a', 'i') LEFT JOIN pg_attribute AS "a" ON "a"."attrelid" = "d"."refobjid" AND "a"."attnum" = "d"."refobjsubid" WHERE "s"."oid" IN (${tables})`,
    ),
    execute(
      `SELECT 'trigger', "tgrelid"::regclass::text, "tgname", pg_get_triggerdef("oid") FROM pg_trigger WHERE "tgrelid" IN (${tables}) AND NOT "tgisinternal"`,
    ),
  ]);
  return sections.flatMap((rows) => listed(rows, local)).sort();
};

// Every row of every table under the prefix, but when each version came in.
const rowsOf = async (
  target: StorageSchemaTarget,
  dialect: LatestSchemaContractArgs["dialect"],
): Promise<Readonly<Record<string, readonly string[]>>> => {
  const { execute, prefix } = target;
  const names = await execute(
    dialect === "sqlite"
      ? `SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND substr("name", 1, ${prefix.length}) = '${prefix}'`
      : `SELECT "tablename" AS "name" FROM pg_tables WHERE "schemaname" = current_schema() AND starts_with("tablename", '${prefix}')`,
  );
  const migrations = schemaMigrationsTableFor(prefix);
  const contents: Record<string, readonly string[]> = {};
  for (const { name } of names) {
    const table = `"${String(name)}"`;
    const rows = await execute(
      table === migrations ? `SELECT "scope", "version" FROM ${table}` : `SELECT * FROM ${table}`,
    );
    contents[String(name).slice(prefix.length)] = rows.map((row) => JSON.stringify(row)).sort();
  }
  return contents;
};

const expectSame = async (
  created: LatestSchemaTarget,
  replayed: LatestSchemaTarget,
  dialect: LatestSchemaContractArgs["dialect"],
): Promise<void> => {
  const schema = await schemaOf(created, dialect);
  expect(schema.length).toBeGreaterThan(0);
  expect(schema).toEqual(await schemaOf(replayed, dialect));
  const rows = await rowsOf(created, dialect);
  expect(Object.keys(rows)).toContain("migrations");
  expect(rows.migrations?.length).toBeGreaterThan(0);
  expect(rows).toEqual(await rowsOf(replayed, dialect));
};

/**
 * What every SQL adapter guarantees of a new database: the tables it creates in one pass are the
 * ones every migration in turn would have left, column for column, index for index, constraint for
 * constraint, recorded at the same versions. A migration added without changing a scope's latest
 * schema fails here.
 */
export const latestSchemaContract: LatestSchemaContractFunction = ({ create, dialect }) => {
  describe("latest schema contract", () => {
    it("creates a new database as every migration in turn leaves it", async () => {
      const created = await create();
      await created.adapter.migrate(SCOPES);
      const replayed = await create();
      await replayed.replay();
      await expectSame(created, replayed, dialect);
    });

    it("creates the storage, then the forget ledger and the tenant keys beside it, as every migration in turn leaves them", async () => {
      const created = await create();
      const storage = await created.adapter.createStorage();
      await storage.close();
      await created.adapter.migrate(["forget-ledger"]);
      await created.adapter.migrate(["tenant-keys"]);
      const replayed = await create();
      await replayed.replay();
      await expectSame(created, replayed, dialect);
    });
  });
};

export interface ReplaySqliteSchemasArgs {
  readonly db: SqlDatabase;
  readonly prefix: string;
}

export interface ReplaySqliteSchemasFunction {
  (args: ReplaySqliteSchemasArgs): Promise<void>;
}

/**
 * A `LatestSchemaTarget`'s `replay` on a SQLite adapter's own connection to its database.
 */
export const replaySqliteSchemas: ReplaySqliteSchemasFunction = ({ db, prefix }) =>
  replaySqlite({ db, prefix, scopes: Object.values(sqliteSchemaScopesFor(prefix)) });
