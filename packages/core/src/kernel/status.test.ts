import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "../adapter/sqlite/node-sqlite.ts";
import { resolveConfig } from "../config/schema.ts";
import { memory } from "../memory/index.ts";
import { databasesOf, readAppStatus } from "./status.ts";

describe("databasesOf", () => {
  it("names each database once, an adapter over the storage's own database included", () => {
    const directory = mkdtempSync(join(tmpdir(), "bounda-databases-"));
    const storage = createNodeSqliteAdapter(join(directory, "storage.db")).adapter;
    const alsoStorage = createNodeSqliteAdapter(join(directory, "storage.db")).adapter;
    const reports = createNodeSqliteAdapter(join(directory, "reports.db")).adapter;
    const names = databasesOf(
      resolveConfig({
        storage,
        readModels: { orders: alsoStorage, reports, totals: reports, notes: memory() },
      }),
    ).map(({ database, scopes }) => [database, scopes]);
    expect(names).toEqual([
      ["storage", ["storage", "checkpoints"]],
      ["readModels.reports", ["checkpoints"]],
      ["readModels.notes", ["checkpoints"]],
    ]);
  });
});

describe("readAppStatus", () => {
  const failure = (subscriber: string, position: number, resolvedAt: string | null = null) => ({
    subscriber,
    position,
    eventId: `e-${position}`,
    eventType: "OrderPlaced",
    person: null,
    errorName: "Error",
    errorMessage: "boom",
    attempts: 1,
    firstFailedAt: "2026-01-01T00:00:00.000Z",
    lastFailedAt: "2026-01-01T00:00:00.000Z",
    resolvedAt,
  });

  it("says a failure is current only while its subscriber is behind it, unresolved and still run", async () => {
    const { subscriberFailures } = await memory().createStorage();
    for (const each of [
      failure("projection:behind", 5),
      failure("projection:on", 4),
      failure("projection:past", 3),
      failure("projection:resolved", 9, "2026-01-02T00:00:00.000Z"),
      failure("projection:gone", 9),
    ]) {
      const { attempts: _a, firstFailedAt, lastFailedAt: _l, resolvedAt, ...recorded } = each;
      await subscriberFailures.record({ ...recorded, failedAt: firstFailedAt });
      if (resolvedAt !== null) {
        await subscriberFailures.resolve(each.subscriber, new Date(resolvedAt));
      }
    }
    const lag = (subscriber: string, position: number) => ({
      subscriber,
      position,
      lag: 9 - position,
    });
    const status = await readAppStatus({
      // A definition without factories, as a Cloudflare one is outside its object: no tables to read.
      config: resolveConfig({ storage: { kind: "bounda-adapter", name: "x", options: {} } }),
      lag: async () => ({
        lastPosition: 9,
        maxLag: 5,
        subscribers: [
          lag("projection:behind", 4),
          lag("projection:on", 4),
          lag("projection:past", 4),
          lag("projection:resolved", 4),
        ],
        waitingDeadlines: 0,
        forgetLedger: null,
        personalDataBackfill: null,
      }),
      failures: subscriberFailures,
      restores: { check: async () => null, found: async () => 0 },
    });
    expect(
      Object.fromEntries(status.subscriberFailures.map((each) => [each.subscriber, each.current])),
    ).toEqual({
      "projection:behind": true,
      "projection:gone": false,
      "projection:on": false,
      "projection:past": false,
      "projection:resolved": false,
    });
    expect(status.schema).toEqual([]);
    expect(status.subscriberFailures[0]).not.toHaveProperty("errorMessage");
  });
});
