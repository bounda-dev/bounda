import {
  eventStoreContract,
  readModelRebuildContract,
  readModelTransactionContract,
  tenantFenceContract,
} from "@bounda-dev/core/adapter/testing";
import { startContainer } from "@bounda-dev/test-containers";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, describe } from "vitest";
import { type SqliteAdapter, sqlite } from "./index.ts";

const server = await startContainer(() =>
  new GenericContainer("ghcr.io/tursodatabase/libsql-server:v0.24.33")
    .withExposedPorts(8080)
    .withWaitStrategy(Wait.forHttp("/health", 8080))
    .start(),
);
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
  eventStoreContract({ create: () => fresh().createStorage() });
  readModelTransactionContract({ create: async () => fresh(), locking: "single-writer" });
  readModelRebuildContract({ create: async () => fresh() });
  tenantFenceContract({ create: async () => fresh() });
});
