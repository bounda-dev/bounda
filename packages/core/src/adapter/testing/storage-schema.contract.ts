import { describe, expect, it } from "vitest";
import { ConfigurationError, StorageSchemaTooNewError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import type { Adapter, Storage } from "../adapter.ts";
import { schemaMigrationsTableFor, schemaMigrationsTableStatement } from "../sql/migrations.ts";
import { earlierRowsFor, expectEarlierRowsTakenIn } from "./earlier-rows.ts";
import { EARLIER_SCHEMAS, type EarlierVersion, earlierTablesFor } from "./earlier-schemas.ts";
import { contractFields } from "./table.contract.ts";

/**
 * A database for one case: `adapter` opens it under `prefix`, and `execute` runs a statement on
 * it outside the adapter.
 */
export interface StorageSchemaTarget {
  readonly adapter: Adapter;
  readonly prefix: string;
  readonly execute: (statement: string) => Promise<readonly Record<string, unknown>[]>;
}

export interface StorageSchemaContractArgs {
  // A new database, or a new prefix in one, on every call.
  readonly create: () => Promise<StorageSchemaTarget>;
  readonly dialect: "sqlite" | "postgresql";
  // Whether storages opening at once can be awaited together; not inside a Durable Object.
  readonly concurrent?: boolean;
}

export interface StorageSchemaContractFunction {
  (args: StorageSchemaContractArgs): void;
}

// What a new database holds: every scope the storage migrates, at its latest version.
const LATEST = [
  { scope: "checkpoints", version: 1 },
  { scope: "storage", version: 1 },
];

const versionsOf = async ({ execute, prefix }: StorageSchemaTarget) =>
  (
    await execute(
      `SELECT "scope", "version", "applied_at" FROM ${schemaMigrationsTableFor(prefix)} ORDER BY "scope", "version"`,
    )
  ).map(({ scope, version, applied_at }) => ({
    scope: String(scope),
    version: Number(version),
    appliedAt: String(applied_at),
  }));

const opened = async <T>(adapter: Adapter, work: (storage: Storage) => Promise<T>): Promise<T> => {
  const storage = await adapter.createStorage();
  try {
    return await work(storage);
  } finally {
    await storage.close();
  }
};

/**
 * The shape of a prefix's tables, the prefix taken out of every name so two prefixes compare:
 * columns with their type, nullability and primary key, then indexes and triggers as the engine
 * keeps their definition. Defaults are left out: a column added to an existing table needs one
 * where a new table has none.
 */
const shapeOf = async (
  { execute, prefix }: StorageSchemaTarget,
  dialect: StorageSchemaContractArgs["dialect"],
): Promise<readonly string[]> => {
  const local = (text: unknown): string => String(text).replaceAll(prefix, "<prefix>");
  if (dialect === "sqlite") {
    const objects = await execute(
      `SELECT "type", "name", "sql" FROM sqlite_master WHERE substr("name", 1, ${prefix.length}) = '${prefix}' ORDER BY "type", "name"`,
    );
    const shape: string[] = [];
    for (const object of objects) {
      if (object.type === "table") {
        const columns = await execute(`PRAGMA table_info("${String(object.name)}")`);
        for (const column of columns) {
          shape.push(
            `column ${local(object.name)}.${String(column.name)} ${String(column.type)} notnull=${String(column.notnull)} pk=${String(column.pk)}`,
          );
        }
      } else {
        shape.push(`${String(object.type)} ${local(object.name)} ${local(object.sql)}`);
      }
    }
    return shape.sort();
  }
  const columns = await execute(
    `SELECT "table_name", "column_name", "data_type", "is_nullable" FROM information_schema.columns WHERE "table_schema" = current_schema() AND starts_with("table_name", '${prefix}')`,
  );
  const indexes = await execute(
    `SELECT "indexname", "indexdef" FROM pg_indexes WHERE "schemaname" = current_schema() AND starts_with("tablename", '${prefix}')`,
  );
  return [
    ...columns.map(
      (column) =>
        `column ${local(column.table_name)}.${String(column.column_name)} ${String(column.data_type)} nullable=${String(column.is_nullable)}`,
    ),
    ...indexes.map((index) => `index ${local(index.indexname)} ${local(index.indexdef)}`),
  ].sort();
};

const createEarlier = async (
  target: StorageSchemaTarget,
  dialect: StorageSchemaContractArgs["dialect"],
  version: EarlierVersion,
): Promise<void> => {
  for (const statement of EARLIER_SCHEMAS[dialect][version](earlierTablesFor(target.prefix))) {
    await target.execute(statement);
  }
};

/**
 * What every adapter does with the versions of its own tables: a new database starts at the latest,
 * an unversioned one from a released version is taken in with what it holds, instances starting
 * together migrate it once, and a database a newer version migrated is refused untouched.
 */
export const storageSchemaContract: StorageSchemaContractFunction = ({
  create,
  dialect,
  concurrent = true,
}) => {
  describe("storage schema contract", () => {
    it("starts a new database at the latest version of every scope", async () => {
      const target = await create();
      await opened(target.adapter, async () => undefined);
      expect((await versionsOf(target)).map(({ scope, version }) => ({ scope, version }))).toEqual(
        LATEST,
      );
    });

    it("opens a database at the latest version without migrating it again", async () => {
      const target = await create();
      await opened(target.adapter, (storage) => storage.checkpointStore.set("projection:x", 7));
      const before = await versionsOf(target);
      const shape = await shapeOf(target, dialect);
      expect(
        await opened(target.adapter, (storage) => storage.checkpointStore.get("projection:x")),
      ).toBe(7);
      expect(await versionsOf(target)).toEqual(before);
      expect(await shapeOf(target, dialect)).toEqual(shape);
    });

    it.skipIf(!concurrent)("migrates once when instances start together", async () => {
      const target = await create();
      const storages = await Promise.all([1, 2, 3].map(() => target.adapter.createStorage()));
      try {
        for (const storage of storages) expect(await storage.eventStore.lastPosition()).toBe(0);
      } finally {
        await Promise.all(storages.map((storage) => storage.close()));
      }
      expect((await versionsOf(target)).map(({ scope, version }) => ({ scope, version }))).toEqual(
        LATEST,
      );
    });

    it("refuses a database a newer version migrated, and leaves it as it was", async () => {
      const target = await create();
      const table = schemaMigrationsTableFor(target.prefix);
      await target.execute(schemaMigrationsTableStatement(table));
      await target.execute(
        `INSERT INTO ${table} ("scope", "version", "applied_at") VALUES ('storage', 999, '2099-01-01T00:00:00.000Z')`,
      );
      const shape = await shapeOf(target, dialect);
      const refused = target.adapter.createStorage();
      await expect(refused).rejects.toBeInstanceOf(StorageSchemaTooNewError);
      await expect(refused).rejects.toMatchObject({
        code: "STORAGE_SCHEMA_TOO_NEW",
        scope: "storage",
        version: 999,
        supported: 1,
      });
      expect(await shapeOf(target, dialect)).toEqual(shape);
    });

    for (const version of ["0.2.0", "0.3.0"] as const) {
      it(`takes in the tables of Bounda ${version} with what they hold, as a new database has them`, async () => {
        const fresh = await create();
        await opened(fresh.adapter, async () => undefined);
        const target = await create();
        await createEarlier(target, dialect, version);
        const tables = earlierTablesFor(target.prefix);
        for (const statement of earlierRowsFor(version, tables)) await target.execute(statement);
        await opened(target.adapter, (storage) =>
          expectEarlierRowsTakenIn({ storage, version, execute: target.execute, tables }),
        );
        expect(await shapeOf(target, dialect)).toEqual(await shapeOf(fresh, dialect));
        expect(
          (await versionsOf(target)).map(({ scope, version: at }) => ({ scope, version: at })),
        ).toEqual(LATEST);
      });
    }

    it("takes in a database the current tables were created in before they were versioned", async () => {
      const target = await create();
      await opened(target.adapter, (storage) => storage.checkpointStore.set("projection:x", 3));
      const shape = await shapeOf(target, dialect);
      await target.execute(`DROP TABLE ${schemaMigrationsTableFor(target.prefix)}`);
      expect(
        await opened(target.adapter, (storage) => storage.checkpointStore.get("projection:x")),
      ).toBe(3);
      expect(await shapeOf(target, dialect)).toEqual(shape);
    });

    it("refuses tables older than 0.2.0, which had to be created again since", async () => {
      const target = await create();
      const { inbox } = earlierTablesFor(target.prefix);
      await target.execute(
        `CREATE TABLE ${inbox} ("subscriber" TEXT NOT NULL, "event_id" TEXT NOT NULL, PRIMARY KEY ("subscriber", "event_id"))`,
      );
      const shape = await shapeOf(target, dialect);
      const refused = target.adapter.createStorage();
      await expect(refused).rejects.toBeInstanceOf(ConfigurationError);
      await expect(refused).rejects.toThrow(/before 0\.2\.0/);
      expect(await shapeOf(target, dialect)).toEqual(shape);
    });

    it("versions a forget ledger's table in its own scope where the ledger lives", async () => {
      const target = await create();
      const ledger = await target.adapter.createForgetLedger({ tenant: "t-1" });
      try {
        await ledger.append([
          { personId: "p-1", eventId: "e-1", forgottenAt: "2026-01-01T00:00:00.000Z" },
        ]);
      } finally {
        await ledger.close?.();
      }
      expect((await versionsOf(target)).map(({ scope, version }) => ({ scope, version }))).toEqual([
        { scope: "forget-ledger", version: 1 },
      ]);
    });

    it("versions the checkpoints of read models in a database of their own", async () => {
      const target = await create();
      const readModel = await target.adapter.createReadModel({
        name: "orderSummary",
        fields: contractFields,
        logger: silentLogger,
      });
      await readModel.close();
      expect((await versionsOf(target)).map(({ scope, version }) => ({ scope, version }))).toEqual([
        { scope: "checkpoints", version: 1 },
      ]);
    });
  });
};
