import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  eventStoreContract,
  latestSchemaContract,
  readModelRebuildContract,
  readModelTransactionContract,
  replaySqliteSchemas,
  tenantFenceContract,
} from "@bounda-dev/core/adapter/testing";
import { startContainer } from "@bounda-dev/test-containers";
import { createClient } from "@libsql/client";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, describe, expect, it } from "vitest";
import { createSqliteDatabase } from "./database.ts";
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

const clients: { close(): void }[] = [];

// In front of the server: counts the requests a client sends it, each a round trip.
let requests = 0;
const counter = createServer(async (request, response) => {
  requests += 1;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const answer = await fetch(`${url}${request.url ?? "/"}`, {
    method: request.method ?? "GET",
    headers: { "content-type": request.headers["content-type"] ?? "application/json" },
    ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
  });
  response.writeHead(answer.status, {
    "content-type": answer.headers.get("content-type") ?? "application/json",
  });
  response.end(Buffer.from(await answer.arrayBuffer()));
});
await new Promise<void>((resolve) => counter.listen(0, "127.0.0.1", resolve));
const counted = `http://127.0.0.1:${(counter.address() as AddressInfo).port}`;

const requestsOf = async (work: () => Promise<unknown>): Promise<number> => {
  const before = requests;
  await work();
  return requests - before;
};

afterAll(async () => {
  for (const client of clients) client.close();
  await new Promise((resolve) => counter.close(resolve));
  await server?.stop();
});

describe.skipIf(server === null)("sqlite adapter on a libSQL server", () => {
  eventStoreContract({ create: () => fresh().createStorage() });
  readModelTransactionContract({ create: async () => fresh(), locking: "single-writer" });
  readModelRebuildContract({ create: async () => fresh() });
  tenantFenceContract({ create: async () => fresh() });

  it("creates a new database's tables in a few requests, however many migrations shaped them", async () => {
    const adapter = sqlite({ url: counted, tablePrefix: "requests_" });
    expect(
      await requestsOf(async () => {
        const storage = await adapter.createStorage();
        await storage.close();
      }),
    ).toBeLessThanOrEqual(4);
    expect(await requestsOf(() => adapter.migrate(["forget-ledger"]))).toBeLessThanOrEqual(6);
    expect(await requestsOf(() => adapter.migrate(["tenant-keys"]))).toBeLessThanOrEqual(6);
    expect(
      await requestsOf(async () => {
        const storage = await adapter.createStorage();
        await storage.close();
      }),
    ).toBe(1);
  });

  latestSchemaContract({
    create: async () => {
      prefixes += 1;
      const prefix = `t${prefixes}_`;
      const client = createClient({ url });
      clients.push(client);
      return {
        adapter: sqlite({ url, tablePrefix: prefix }),
        prefix,
        execute: async (statement) => {
          const result = await client.execute(statement);
          return result.rows.map((row) =>
            Object.fromEntries(result.columns.map((column, index) => [column, row[index] ?? null])),
          );
        },
        replay: () =>
          replaySqliteSchemas({
            db: createSqliteDatabase(client, { local: false, wal: false }).db,
            prefix,
          }),
      };
    },
    dialect: "sqlite",
  });
});
