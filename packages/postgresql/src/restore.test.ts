import { restoreContract } from "@bounda-dev/core/adapter/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, describe } from "vitest";
import { postgresql } from "./index.ts";

const startContainer = async (): Promise<StartedPostgreSqlContainer | null> => {
  try {
    return await new PostgreSqlContainer("postgres:17").start();
  } catch {
    return null;
  }
};

const container = await startContainer();
const url = container?.getConnectionUri() ?? "";
let schemas = 0;

afterAll(async () => {
  await container?.stop();
});

// The server's own tools, run where the server is.
const tool = async (command: readonly string[]): Promise<void> => {
  if (container === null) return;
  const { exitCode, output } = await container.exec([
    ...command,
    "--username",
    container.getUsername(),
    "--dbname",
    container.getDatabase(),
  ]);
  if (exitCode !== 0) throw new Error(`${command[0]} exited with ${exitCode}: ${output}`);
};

describe.skipIf(container === null)("restoring a PostgreSQL schema", () => {
  restoreContract({
    hot: true,
    create: async () => {
      schemas += 1;
      const schema = `restored_${schemas}`;
      const file = `/tmp/${schema}.dump`;
      const storage = postgresql({ url, schema, maxConnections: 3 });
      return {
        storage,
        forgetLedger: postgresql({ url, schema: `ledger_${schemas}`, maxConnections: 2 }),
        // pg_dump takes a consistent snapshot while the app writes.
        backUp: () => tool(["pg_dump", "--schema", schema, "--format", "custom", "--file", file]),
        // In place, in one transaction: the app's connections see the schema before the restore or
        // after it.
        restore: async () => {
          await tool([
            "pg_restore",
            "--clean",
            "--if-exists",
            "--single-transaction",
            "--schema",
            schema,
            file,
          ]);
          return storage;
        },
      };
    },
  });
});
