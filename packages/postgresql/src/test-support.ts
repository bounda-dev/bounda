import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";

export interface TestDatabase {
  readonly container: StartedPostgreSqlContainer;
  readonly database: string;
  readonly url: string;
  readonly close: () => Promise<void>;
}

export interface StartTestDatabaseFunction {
  (): Promise<TestDatabase | null>;
}

const reuseContainer = process.env.BOUNDA_PG_REUSE === "1";

const onServer = async (
  container: StartedPostgreSqlContainer,
  statement: string,
): Promise<void> => {
  const sql = postgres(container.getConnectionUri(), { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 });
  }
};

// A database of its own on a PostgreSQL server, or null when Docker is not running.
// BOUNDA_PG_REUSE=1 keeps one server for every run, as Stryker runs the tests once per mutant;
// each run still gets a database it drops at the end, since information_schema reads slow down as
// the server's catalog fills with the tables of earlier runs.
export const startTestDatabase: StartTestDatabaseFunction = async () => {
  let container: StartedPostgreSqlContainer;
  try {
    const definition = new PostgreSqlContainer("postgres:17");
    container = await (reuseContainer ? definition.withReuse() : definition).start();
  } catch {
    return null;
  }
  const database = `run_${randomUUID().replaceAll("-", "")}`;
  await onServer(container, `CREATE DATABASE "${database}"`);
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${database}`;
  return {
    container,
    database,
    url: url.toString(),
    close: async () => {
      if (reuseContainer) await onServer(container, `DROP DATABASE "${database}" WITH (FORCE)`);
      else await container.stop();
    },
  };
};
