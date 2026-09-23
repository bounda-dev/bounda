import { silentLogger } from "@bounda-dev/core";
import {
  eventStoreContract,
  readModelRebuildContract,
  readModelTransactionContract,
} from "@bounda-dev/core/adapter/testing";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, describe } from "vitest";
import { type SqliteAdapter, sqlite } from "./index.ts";

const startServer = async (): Promise<StartedTestContainer | null> => {
  try {
    return await new GenericContainer("ghcr.io/tursodatabase/libsql-server:v0.24.33")
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp("/health", 8080))
      .start();
  } catch {
    return null;
  }
};

const server = await startServer();
const url = server === null ? "" : `http://${server.getHost()}:${server.getMappedPort(8080)}`;
let prefixes = 0;

const fresh = (): SqliteAdapter => {
  prefixes += 1;
  return sqlite({ url, tablePrefix: `t${prefixes}_` });
};

afterAll(async () => {
  await server?.stop();
});

describe.skipIf(server === null)("sqlite adapter on a libSQL server", () => {
  eventStoreContract({
    create: async () => (await fresh().createStorage({ logger: silentLogger })).eventStore,
  });
  readModelTransactionContract({ create: async () => fresh(), locking: "single-writer" });
  readModelRebuildContract({ create: async () => fresh() });
});
