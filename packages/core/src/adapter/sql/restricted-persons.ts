import type { FieldsRecord } from "../../modules/view.ts";
import {
  type RestrictedPersonsStore,
  type RestrictedReads,
  restrictedFieldsOf,
} from "../storage/restricted-persons.ts";
import { RETAINED_KEY_PREFIX } from "../storage/sealed-fields.ts";
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
      await db.run(`DELETE FROM ${table} WHERE "person" = ${p(1)}`, [person]);
      for (const { ground, categories } of restrictions) {
        for (const category of categories ?? [WHOLE_PERSON]) {
          await insert(person, ground, category);
        }
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
  readonly dialect: Pick<SqlDialect, "placeholder">;
}

export interface RestrictedRowsConditionFunction {
  (args: RestrictedRowsConditionArgs): SqlCondition;
}

/**
 * True for a row whose person asked for no restriction that covers it: neither as a whole nor in a
 * category of the read model.
 */
export const restrictedRowsCondition: RestrictedRowsConditionFunction = ({
  restrictedPersons,
  person,
  categories,
  dialect,
}) => {
  return (offset) => {
    const params: unknown[] = [WHOLE_PERSON, ...categories];
    const among = params.map((_, index) => dialect.placeholder(offset + index + 1)).join(", ");
    return {
      sql: `NOT EXISTS (SELECT 1 FROM ${restrictedPersons} AS "r" WHERE "r"."person" = ${person} AND "r"."category" IN (${among}))`,
      params,
    };
  };
};

export interface RetainedRowsConditionArgs {
  /**
   * The key columns of the row, qualified and quoted.
   */
  readonly keys: readonly string[];
  readonly dialect: Pick<SqlDialect, "placeholder">;
}

export interface RetainedRowsConditionFunction {
  (args: RetainedRowsConditionArgs): SqlCondition;
}

/**
 * True for a row with no value under a key a forgetting kept under a legal obligation.
 */
export const retainedRowsCondition: RetainedRowsConditionFunction = ({ keys, dialect }) => {
  return (offset) => ({
    sql: keys
      .map(
        (key, index) =>
          `(${key} IS NULL OR ${key} NOT LIKE ${dialect.placeholder(offset + index + 1)})`,
      )
      .join(" AND "),
    params: keys.map(() => `${RETAINED_KEY_PREFIX}%`),
  });
};

const both =
  (first: SqlCondition, second: SqlCondition | null): SqlCondition =>
  (offset) => {
    const one = first(offset);
    if (second === null) return one;
    const other = second(offset + one.params.length);
    return { sql: `${one.sql} AND ${other.sql}`, params: [...one.params, ...other.params] };
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
  const columns = columnsOf({ readModel, fields, dialect });
  const qualified = (field: string) =>
    `${quoteIdentifier(table)}.${quoteIdentifier(
      columns.find((column) => column.field === field)?.name ?? field,
    )}`;
  const requested =
    restricted === null
      ? null
      : restrictedRowsCondition({
          restrictedPersons,
          person: qualified(restricted.person),
          categories: restricted.categories,
          dialect,
        });
  const retained =
    restricted === null || restricted.keyFields.length === 0
      ? null
      : retainedRowsCondition({ keys: restricted.keyFields.map(qualified), dialect });
  const tables = {
    unrestricted: requested === null ? plain : tableOf(both(requested, retained)),
    retained: requested === null ? plain : tableOf(requested),
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
