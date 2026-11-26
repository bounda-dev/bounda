import type {
  DeclaredRecipient,
  Disclosure,
  ForgottenRecipient,
  ForgottenRecipientStatus,
  RecipientStore,
  StoredDisclosure,
} from "../storage/recipient-store.ts";
import type { SqlDialect } from "./dialect.ts";
import type { SqlExecutor } from "./sql-table.ts";

export interface CreateSqlRecipientStoreArgs {
  readonly db: SqlExecutor;
  /**
   * All three already quoted.
   */
  readonly disclosures: string;
  readonly recipients: string;
  readonly forgotten: string;
  readonly dialect: Pick<SqlDialect, "placeholder">;
}

export interface CreateSqlRecipientStoreFunction {
  (args: CreateSqlRecipientStoreArgs): RecipientStore;
}

const DISCLOSURE_COLUMNS = `"person", "port", "recipient", "kind", "country", "safeguard", "category", "first_at", "last_at"`;

const storedDisclosure = (row: Readonly<Record<string, unknown>>): StoredDisclosure => ({
  person: String(row.person),
  port: String(row.port),
  recipient: String(row.recipient),
  kind: String(row.kind),
  country: String(row.country),
  safeguard: row.safeguard === null ? null : String(row.safeguard),
  category: String(row.category),
  firstAt: String(row.first_at),
  lastAt: String(row.last_at),
});

const declaredRecipient = (row: Readonly<Record<string, unknown>>): DeclaredRecipient => ({
  port: String(row.port),
  categories: JSON.parse(String(row.categories)) as readonly string[],
  presumedThrough: Number(row.presumed_through),
  caughtUpThrough: Number(row.caught_up_through),
  declaredAt: String(row.declared_at),
});

const FORGOTTEN_COLUMNS = `"port", "recipient", "kind", "country", "safeguard", "status", "category", "persons"`;

const FORGOTTEN_KEY = `"port", "recipient", "kind", "country", "safeguard", "status", "category"`;

// A count's safeguard and category are part of its key, which holds no null: `''` stands for none.
const forgottenRecipient = (row: Readonly<Record<string, unknown>>): ForgottenRecipient => ({
  port: String(row.port),
  recipient: String(row.recipient),
  kind: String(row.kind),
  country: String(row.country),
  safeguard: row.safeguard === "" ? null : String(row.safeguard),
  status: String(row.status) as ForgottenRecipientStatus,
  category: row.category === "" ? null : String(row.category),
  persons: Number(row.persons),
});

// Within the hundred parameters a Durable Object's SQLite binds to one statement.
const PERSONS_PER_STATEMENT = 90;

/**
 * `RecipientStore` on the SQL SQLite and PostgreSQL both speak. A disclosure is inserted with
 * `ON CONFLICT DO NOTHING` first, so two writers recording the same one tell which of them added
 * it, and its last time moved forward after.
 */
export const createSqlRecipientStore: CreateSqlRecipientStoreFunction = ({
  db,
  disclosures,
  recipients,
  forgotten,
  dialect,
}) => {
  const p = dialect.placeholder;
  const declared = async (): Promise<readonly DeclaredRecipient[]> =>
    (
      await db.all(
        `SELECT "port", "categories", "presumed_through", "caught_up_through", "declared_at" FROM ${recipients} ORDER BY "port"`,
        [],
      )
    ).map(declaredRecipient);
  return {
    disclose: async (rows, at) => {
      const added: Disclosure[] = [];
      for (const row of rows) {
        const inserted = await db.all(
          `INSERT INTO ${disclosures} (${DISCLOSURE_COLUMNS}) VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}) ON CONFLICT ("person", "port", "recipient", "category") DO NOTHING RETURNING "person"`,
          [
            row.person,
            row.port,
            row.recipient,
            row.kind,
            row.country,
            row.safeguard,
            row.category,
            at,
            at,
          ],
        );
        if (inserted.length === 1) {
          added.push(row);
          continue;
        }
        await db.run(
          `UPDATE ${disclosures} SET "last_at" = ${p(1)} WHERE "person" = ${p(2)} AND "port" = ${p(3)} AND "recipient" = ${p(4)} AND "category" = ${p(5)} AND "last_at" < ${p(6)}`,
          [at, row.person, row.port, row.recipient, row.category, at],
        );
      }
      return added;
    },
    disclosuresOfMany: async (persons) => {
      const listed = new Map<string, StoredDisclosure[]>();
      const distinct = [...new Set(persons)];
      for (let start = 0; start < distinct.length; start += PERSONS_PER_STATEMENT) {
        const chunk = distinct.slice(start, start + PERSONS_PER_STATEMENT);
        const rows = await db.all(
          `SELECT ${DISCLOSURE_COLUMNS} FROM ${disclosures} WHERE "person" IN (${chunk.map((_, index) => p(index + 1)).join(", ")}) ORDER BY "person", "port", "recipient", "category"`,
          chunk,
        );
        for (const row of rows) {
          const disclosure = storedDisclosure(row);
          listed.set(disclosure.person, [...(listed.get(disclosure.person) ?? []), disclosure]);
        }
      }
      return listed;
    },
    disclosures: async (person) =>
      (
        await db.all(
          `SELECT ${DISCLOSURE_COLUMNS} FROM ${disclosures} WHERE "person" = ${p(1)} ORDER BY "port", "recipient", "category"`,
          [person],
        )
      ).map(storedDisclosure),
    forget: async (person, categories) => {
      if (categories === null) {
        await db.run(`DELETE FROM ${disclosures} WHERE "person" = ${p(1)}`, [person]);
        return;
      }
      for (const category of categories) {
        await db.run(
          `DELETE FROM ${disclosures} WHERE "person" = ${p(1)} AND "category" = ${p(2)}`,
          [person, category],
        );
      }
    },
    declare: async (ports, position, at) => {
      for (const { port, categories } of ports) {
        await db.run(
          `INSERT INTO ${recipients} ("port", "categories", "presumed_through", "caught_up_through", "declared_at") VALUES (${p(1)}, ${p(2)}, ${p(3)}, 0, ${p(4)}) ON CONFLICT ("port") DO UPDATE SET "categories" = ${p(5)}`,
          [port, JSON.stringify(categories), position, at, JSON.stringify(categories)],
        );
      }
      return declared();
    },
    declared,
    presumeThrough: async (position) => {
      await db.run(
        `UPDATE ${recipients} SET "presumed_through" = ${p(1)} WHERE "presumed_through" < ${p(2)}`,
        [position, position],
      );
    },
    rename: async (from, to) => {
      const later = (column: string, table: string) =>
        `CASE WHEN excluded."${column}" > ${table}."${column}" THEN excluded."${column}" ELSE ${table}."${column}" END`;
      const earlier = (column: string, table: string) =>
        `CASE WHEN excluded."${column}" < ${table}."${column}" THEN excluded."${column}" ELSE ${table}."${column}" END`;
      await db.run(
        `INSERT INTO ${disclosures} (${DISCLOSURE_COLUMNS}) SELECT "person", ${p(1)}, "recipient", "kind", "country", "safeguard", "category", "first_at", "last_at" FROM ${disclosures} WHERE "port" = ${p(2)} ON CONFLICT ("person", "port", "recipient", "category") DO UPDATE SET "first_at" = ${earlier("first_at", disclosures)}, "last_at" = ${later("last_at", disclosures)}`,
        [to, from],
      );
      await db.run(`DELETE FROM ${disclosures} WHERE "port" = ${p(1)}`, [from]);
      await db.run(
        `INSERT INTO ${recipients} ("port", "categories", "presumed_through", "caught_up_through", "declared_at") SELECT ${p(1)}, "categories", "presumed_through", "caught_up_through", "declared_at" FROM ${recipients} WHERE "port" = ${p(2)} ON CONFLICT ("port") DO UPDATE SET "presumed_through" = ${later("presumed_through", recipients)}, "caught_up_through" = ${later("caught_up_through", recipients)}`,
        [to, from],
      );
      await db.run(`DELETE FROM ${recipients} WHERE "port" = ${p(1)}`, [from]);
      await db.run(
        `INSERT INTO ${forgotten} (${FORGOTTEN_COLUMNS}) SELECT ${p(1)}, "recipient", "kind", "country", "safeguard", "status", "category", "persons" FROM ${forgotten} WHERE "port" = ${p(2)} ON CONFLICT (${FORGOTTEN_KEY}) DO UPDATE SET "persons" = ${forgotten}."persons" + excluded."persons"`,
        [to, from],
      );
      await db.run(`DELETE FROM ${forgotten} WHERE "port" = ${p(1)}`, [from]);
    },
    caughtUp: async (port, position) => {
      await db.run(
        `UPDATE ${recipients} SET "caught_up_through" = ${p(1)} WHERE "port" = ${p(2)} AND "caught_up_through" < ${p(3)}`,
        [position, port, position],
      );
    },
    summary: async () =>
      (
        await db.all(
          `SELECT "port", COUNT(DISTINCT "person") AS "persons" FROM ${disclosures} GROUP BY "port" ORDER BY "port"`,
          [],
        )
      ).map((row) => ({ port: String(row.port), persons: Number(row.persons) })),
    countForgotten: async (counts) => {
      for (const counted of counts) {
        await db.run(
          `INSERT INTO ${forgotten} (${FORGOTTEN_COLUMNS}) VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}) ON CONFLICT (${FORGOTTEN_KEY}) DO UPDATE SET "persons" = ${forgotten}."persons" + excluded."persons"`,
          [
            counted.port,
            counted.recipient,
            counted.kind,
            counted.country,
            counted.safeguard ?? "",
            counted.status,
            counted.category ?? "",
            counted.persons,
          ],
        );
      }
    },
    forgottenCounts: async () =>
      (await db.all(`SELECT ${FORGOTTEN_COLUMNS} FROM ${forgotten}`, [])).map(forgottenRecipient),
    received: async () => {
      const received = new Map<string, string[]>();
      for (const row of await db.all(
        `SELECT DISTINCT "port", "category" FROM ${disclosures} ORDER BY "port", "category"`,
        [],
      )) {
        const port = String(row.port);
        received.set(port, [...(received.get(port) ?? []), String(row.category)]);
      }
      return received;
    },
    // The limit is written out: a Durable Object's SQLite binds a number as a real, which LIMIT
    // refuses.
    personsOf: async ({ port, after, limit }) =>
      (
        await db.all(
          `SELECT DISTINCT "person" FROM ${disclosures} WHERE "port" = ${p(1)}${after === null ? "" : ` AND "person" > ${p(2)}`} ORDER BY "person" LIMIT ${Math.max(0, Math.trunc(limit))}`,
          after === null ? [port] : [port, after],
        )
      ).map((row) => String(row.person)),
  };
};

export interface ForgottenRecipientsTableStatementFunction {
  (table: string): string;
}

// The counts of forgotten persons by recipient, which migration 12 of SQLite's storage tables and
// 13 of PostgreSQL's add.
export const forgottenRecipientsTableStatement: ForgottenRecipientsTableStatementFunction = (
  table,
) => `CREATE TABLE IF NOT EXISTS ${table} (
    "port" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "safeguard" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "persons" BIGINT NOT NULL,
    PRIMARY KEY ("port", "recipient", "kind", "country", "safeguard", "status", "category")
  )`;

export interface RecipientTablesStatementsFunction {
  (tables: { readonly disclosures: string; readonly recipients: string }): readonly string[];
}

// Migration 6 of the storage tables, on both engines: the primary key leads with the person, which
// `disclosures` and `forget` read by.
export const recipientTablesStatements: RecipientTablesStatementsFunction = ({
  disclosures,
  recipients,
}) => [
  `CREATE TABLE IF NOT EXISTS ${disclosures} (
    "person" TEXT NOT NULL,
    "port" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "safeguard" TEXT,
    "category" TEXT NOT NULL,
    "first_at" TEXT NOT NULL,
    "last_at" TEXT NOT NULL,
    PRIMARY KEY ("person", "port", "recipient", "category")
  )`,
  `CREATE TABLE IF NOT EXISTS ${recipients} (
    "port" TEXT NOT NULL PRIMARY KEY,
    "categories" TEXT NOT NULL,
    "presumed_through" BIGINT NOT NULL,
    "caught_up_through" BIGINT NOT NULL,
    "declared_at" TEXT NOT NULL
  )`,
];
