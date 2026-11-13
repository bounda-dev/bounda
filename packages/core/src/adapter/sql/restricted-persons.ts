import type { FieldsRecord } from "../../modules/view.ts";
import {
  RETAINED_SOURCE,
  type RestrictedPersonsStore,
  type RestrictedReads,
  type RestrictionView,
  restrictedFieldsOf,
} from "../storage/restricted-persons.ts";
import type { SqlDialect } from "./dialect.ts";
import { quoteIdentifier } from "./identifiers.ts";
import { WHOLE_PERSON } from "./person-store.ts";
import { columnsOf } from "./read-model-schema.ts";
import { createSqlTable, type SqlCondition, type SqlExecutor } from "./sql-table.ts";

export interface CreateSqlRestrictedPersonsStoreArgs {
  readonly db: SqlExecutor;
  /**
   * Already quoted, as `positions`.
   */
  readonly table: string;
  readonly positions: string;
  readonly dialect: Pick<SqlDialect, "placeholder">;
}

export interface CreateSqlRestrictedPersonsStoreFunction {
  (args: CreateSqlRestrictedPersonsStoreArgs): RestrictedPersonsStore;
}

/**
 * The read side's copy of who is restricted, on the SQL SQLite and PostgreSQL both speak. Written
 * by one subscriber per database, in the transaction that moves its checkpoint.
 */
export const createSqlRestrictedPersonsStore: CreateSqlRestrictedPersonsStoreFunction = ({
  db,
  table,
  positions,
  dialect,
}) => {
  const p = dialect.placeholder;
  const insert = (person: string, source: string, category: string): Promise<void> =>
    db.run(
      `INSERT INTO ${table} ("person", "source", "category") VALUES (${p(1)}, ${p(2)}, ${p(3)}) ON CONFLICT ("person", "source", "category") DO NOTHING`,
      [person, source, category],
    );
  return {
    // The upsert keeps the greater position and locks the row, so a writer of an older event
    // beside it, in another transaction, waits and then reads the newer one. No `WHERE` or
    // `RETURNING` on the upsert: the one CI run whose upsert had both crashed libSQL's native code
    // on Windows (0xC0000005).
    advance: async (person, position) => {
      await db.run(
        `INSERT INTO ${positions} ("person", "position") VALUES (${p(1)}, ${p(2)}) ON CONFLICT ("person") DO UPDATE SET "position" = CASE WHEN ${positions}."position" > excluded."position" THEN ${positions}."position" ELSE excluded."position" END`,
        [person, position],
      );
      const [held] = await db.all(`SELECT "position" FROM ${positions} WHERE "person" = ${p(1)}`, [
        person,
      ]);
      return Number(held?.position) === position;
    },
    request: async (person, restrictions) => {
      await db.run(`DELETE FROM ${table} WHERE "person" = ${p(1)} AND "source" <> ${p(2)}`, [
        person,
        RETAINED_SOURCE,
      ]);
      for (const { ground, categories } of restrictions) {
        for (const category of categories ?? [WHOLE_PERSON]) {
          await insert(person, ground, category);
        }
      }
    },
    retain: async (person, categories) => {
      for (const category of categories) await insert(person, RETAINED_SOURCE, category);
    },
    release: async (person, categories) => {
      for (const category of categories) {
        await db.run(
          `DELETE FROM ${table} WHERE "person" = ${p(1)} AND "source" = ${p(2)} AND "category" = ${p(3)}`,
          [person, RETAINED_SOURCE, category],
        );
      }
    },
  };
};

export interface RestrictedRowsConditionArgs {
  /**
   * The copy's table, already quoted.
   */
  readonly restrictedPersons: string;
  /**
   * The column that names the row's person, qualified and quoted.
   */
  readonly person: string;
  readonly categories: readonly string[];
  readonly view: Exclude<RestrictionView, "all">;
  readonly dialect: Pick<SqlDialect, "placeholder">;
}

export interface RestrictedRowsConditionFunction {
  (args: RestrictedRowsConditionArgs): SqlCondition;
}

/**
 * True for a row whose person `view` does not leave out: restricted neither as a whole nor in a
 * category of the read model, counting what a forgetting kept only for `unrestricted`.
 */
export const restrictedRowsCondition: RestrictedRowsConditionFunction = ({
  restrictedPersons,
  person,
  categories,
  view,
  dialect,
}) => {
  return (offset) => {
    const params: unknown[] = [WHOLE_PERSON, ...categories];
    const among = params.map((_, index) => dialect.placeholder(offset + index + 1)).join(", ");
    let source = "";
    if (view === "retained") {
      params.push(RETAINED_SOURCE);
      source = ` AND "r"."source" <> ${dialect.placeholder(offset + params.length)}`;
    }
    return {
      sql: `NOT EXISTS (SELECT 1 FROM ${restrictedPersons} AS "r" WHERE "r"."person" = ${person} AND "r"."category" IN (${among})${source})`,
      params,
    };
  };
};

export interface CreateSqlRestrictedReadsArgs {
  readonly readModel: string;
  /**
   * The read model's table, unquoted.
   */
  readonly table: string;
  readonly fields: FieldsRecord;
  readonly dialect: SqlDialect;
  readonly executor: SqlExecutor;
  /**
   * The copy's table, already quoted, in the same database.
   */
  readonly restrictedPersons: string;
}

export interface CreateSqlRestrictedReadsFunction {
  <Row extends object>(args: CreateSqlRestrictedReadsArgs): RestrictedReads<Row>;
}

// Within the hundred parameters a Durable Object's SQLite binds to one statement, the condition's
// own included.
const BOUND_PARAMETERS = 100;

/**
 * `RestrictedReads` over the read model's table and the copy beside it, filtered in the statement
 * itself, so a page and a count leave the rows out before they are cut or counted.
 */
export const createSqlRestrictedReads: CreateSqlRestrictedReadsFunction = <Row extends object>({
  readModel,
  table,
  fields,
  dialect,
  executor,
  restrictedPersons,
}: CreateSqlRestrictedReadsArgs): RestrictedReads<Row> => {
  const restricted = restrictedFieldsOf(fields);
  const tableOf = (reads?: SqlCondition) =>
    createSqlTable<Row>({
      readModel,
      table,
      fields,
      dialect,
      executor,
      ...(reads ? { reads } : {}),
    });
  const plain = tableOf();
  const condition = (view: Exclude<RestrictionView, "all">, person: string) =>
    restricted === null
      ? undefined
      : restrictedRowsCondition({
          restrictedPersons,
          person,
          categories: restricted.categories,
          view,
          dialect,
        });
  const personColumn =
    restricted === null
      ? null
      : `${quoteIdentifier(table)}.${quoteIdentifier(
          columnsOf({ readModel, fields, dialect }).find(
            (column) => column.field === restricted.person,
          )?.name ?? restricted.person,
        )}`;
  const tables = {
    unrestricted: personColumn === null ? plain : tableOf(condition("unrestricted", personColumn)),
    retained: personColumn === null ? plain : tableOf(condition("retained", personColumn)),
  };
  return {
    ...tables,
    among: async (persons, view) => {
      const found = new Set<string>();
      if (restricted === null || view === "all" || persons.length === 0) return found;
      const distinct = [...new Set(persons)];
      const perStatement = Math.max(1, BOUND_PARAMETERS - restricted.categories.length - 2);
      for (let start = 0; start < distinct.length; start += perStatement) {
        const chunk = distinct.slice(start, start + perStatement);
        const names = chunk.map((_, index) => dialect.placeholder(index + 1)).join(", ");
        const leftOut = restrictedRowsCondition({
          restrictedPersons,
          person: `"p"."person"`,
          categories: restricted.categories,
          view,
          dialect,
        })(chunk.length);
        const rows = await executor.all(
          `SELECT "p"."person" FROM (SELECT DISTINCT "person" FROM ${restrictedPersons} WHERE "person" IN (${names})) AS "p" WHERE NOT (${leftOut.sql})`,
          [...chunk, ...leftOut.params],
        );
        for (const row of rows) found.add(String(row.person));
      }
      return found;
    },
  };
};
