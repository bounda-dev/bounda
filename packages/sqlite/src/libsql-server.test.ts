import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { silentLogger } from "@bounda-dev/core";
import {
  contractFields,
  eventStoreContract,
  latestSchemaContract,
  readModelRebuildContract,
  readModelTransactionContract,
  replaySqliteSchemas,
  tenantFenceContract,
} from "@bounda-dev/core/adapter/testing";
import { createClient } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import { createSqliteDatabase } from "./database.ts";
import { type SqliteAdapter, sqlite } from "./index.ts";
import { startTestServer } from "./test-support.ts";

const server = await startTestServer();
const url = server?.url ?? "";
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
  await server?.close();
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

  it("replays a database an earlier version left behind in a few requests per scope, however many migrations it applies", async () => {
    const client = createClient({ url: counted });
    clients.push(client);
    const replayed = await requestsOf(() =>
      replaySqliteSchemas({
        db: createSqliteDatabase(client, { local: false, wal: false }).db,
        prefix: "replayed_",
      }),
    );
    expect(replayed).toBeLessThanOrEqual(51);
  });

  it("opens, commits and aborts a rebuild in a few requests each, however many statements it writes", async () => {
    const adapter = sqlite({ url: counted, tablePrefix: "rebuilds_" });
    const args = {
      name: "orderSummary",
      fields: contractFields,
      logger: silentLogger,
      progress: "rebuild:orderSummary:1",
    };
    // Open throughout, so every rebuild shares its connection.
    const live = await adapter.createReadModel(args);
    let rebuild = await adapter.rebuildReadModel(args);
    await rebuild.pause();
    const opening = await requestsOf(async () => {
      rebuild = await adapter.rebuildReadModel(args);
    });
    const committing = await requestsOf(() =>
      rebuild.commit({ subscriber: "projection:orderSummary", position: 1, marks: { m: 1 } }),
    );
    rebuild = await adapter.rebuildReadModel(args);
    const aborting = await requestsOf(() => rebuild.abort());
    await live.close();
    expect(opening).toBeLessThanOrEqual(6);
    expect(committing).toBeLessThanOrEqual(5);
    expect(aborting).toBeLessThanOrEqual(4);
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
