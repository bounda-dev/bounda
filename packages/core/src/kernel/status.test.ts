import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../adapter/sqlite/node-sqlite.ts";
import { resolveConfig } from "../config/schema.ts";
import { silentLogger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import type { RestoreWatch } from "./shared/restores.ts";
import {
  type AppStatus,
  databasesOf,
  type ReadAppStatusArgs,
  readAppStatus,
  type StatusLag,
  schemaOf,
  unreadableParts,
} from "./status.ts";
import { createRecordingLogger } from "./test-support.ts";

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

  it("names the tenant key store's scope in the database it shares, or as a database of its own", () => {
    const directory = mkdtempSync(join(tmpdir(), "bounda-databases-"));
    const storage = createNodeSqliteAdapter(join(directory, "storage.db")).adapter;
    const reports = createNodeSqliteAdapter(join(directory, "reports.db")).adapter;
    const keys = createNodeSqliteAdapter(join(directory, "keys.db")).adapter;
    const scopesOf = (tenantKeys: typeof keys) =>
      databasesOf(
        resolveConfig({
          storage,
          readModels: { reports },
          runtime: { personalData: { tenantKeys } },
        }),
      ).map(({ database, scopes }) => [database, scopes]);
    expect(scopesOf(createNodeSqliteAdapter(join(directory, "reports.db")).adapter)).toEqual([
      ["storage", ["storage", "checkpoints"]],
      ["readModels.reports", ["checkpoints", "tenant-keys"]],
    ]);
    expect(scopesOf(keys)).toEqual([
      ["storage", ["storage", "checkpoints"]],
      ["readModels.reports", ["checkpoints"]],
      ["tenantKeys", ["tenant-keys"]],
    ]);
  });
});

const restoresFinding = (found: () => Promise<number>): RestoreWatch => ({
  start: async () => null,
  started: async () => undefined,
  check: async () => null,
  declare: async () => ({ first: true }),
  flush: async () => undefined,
  found,
  saw: () => undefined,
});

const down = (part: string) => async (): Promise<never> => {
  throw new Error(`${part} is down`);
};

// A definition without factories, as a Cloudflare one is outside its object: no tables to read.
const tableless = resolveConfig({ storage: { kind: "bounda-adapter", name: "x", options: {} } });

const lagOf = (subscribers: StatusLag["subscribers"]): StatusLag => ({
  lastPosition: 9,
  maxLag: 5,
  subscribers,
  waitingDeadlines: 0,
  forgetLedger: null,
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

  const failuresOf = async (
    failures: readonly ReturnType<typeof failure>[],
  ): Promise<ReadAppStatusArgs["failures"]> => {
    const { subscriberFailures } = await memory().createStorage();
    for (const each of failures) {
      const { attempts: _a, firstFailedAt, lastFailedAt: _l, resolvedAt, ...recorded } = each;
      await subscriberFailures.record({ ...recorded, failedAt: firstFailedAt });
      if (resolvedAt !== null) {
        await subscriberFailures.resolve(each.subscriber, new Date(resolvedAt));
      }
    }
    return subscriberFailures;
  };

  const currentOf = ({ subscriberFailures }: AppStatus) =>
    "unreadable" in subscriberFailures
      ? subscriberFailures
      : Object.fromEntries(subscriberFailures.map((each) => [each.subscriber, each.current]));

  const lag = (subscriber: string, position: number) => ({
    subscriber,
    position,
    lag: 9 - position,
  });

  it("says a failure is current only while its subscriber is behind it, unresolved and still run", async () => {
    const status = await readAppStatus({
      config: tableless,
      logger: silentLogger,
      lag: async () =>
        lagOf([
          lag("projection:behind", 4),
          lag("projection:on", 4),
          lag("projection:past", 4),
          lag("projection:resolved", 4),
          { subscriber: "projection:unread", unreadable: true },
        ]),
      failures: await failuresOf([
        failure("projection:behind", 5),
        failure("projection:on", 4),
        failure("projection:past", 3),
        failure("projection:resolved", 9, "2026-01-02T00:00:00.000Z"),
        failure("projection:gone", 9),
        failure("projection:unread", 9),
      ]),
      restores: restoresFinding(async () => 0),
    });
    expect(currentOf(status)).toEqual({
      "projection:behind": true,
      "projection:gone": false,
      "projection:on": false,
      "projection:past": false,
      "projection:resolved": false,
      "projection:unread": null,
    });
    expect(status.schema).toEqual([]);
    expect(status.subscriberFailures).toEqual([
      expect.not.objectContaining({ errorMessage: expect.anything() }),
      ...Array.from({ length: 5 }, () => expect.anything()),
    ]);
    expect(unreadableParts(status)).toEqual(["lag (projection:unread)"]);
  });

  it("says an unresolved failure may be current while the lag cannot be read, and a resolved one is not", async () => {
    const status = await readAppStatus({
      config: tableless,
      logger: silentLogger,
      lag: down("the event store"),
      failures: await failuresOf([
        failure("projection:stuck", 5),
        failure("projection:resolved", 9, "2026-01-02T00:00:00.000Z"),
      ]),
      restores: restoresFinding(async () => 0),
    });
    expect(currentOf(status)).toEqual({ "projection:stuck": null, "projection:resolved": false });
    expect(status.lag).toEqual({ unreadable: true });
    expect(unreadableParts(status)).toEqual(["lag"]);
  });

  it("reports every part whose store cannot be read unreadable, logs each once, and still reads the others", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bounda-status-"));
    const storage = createNodeSqliteAdapter(join(directory, "storage.db")).adapter;
    const reports = createNodeSqliteAdapter(join(directory, "reports.db")).adapter;
    const brokenReports: Adapter = { ...reports, schemaVersions: down("the reports database") };
    const config = resolveConfig({ storage, readModels: { reports: brokenReports } });
    const { logger, entries } = createRecordingLogger();
    const status = await readAppStatus({
      config,
      logger,
      lag: down("the event store"),
      backfill: down("the backfill's checkpoints"),
      failures: { ...(await failuresOf([])), list: down("the failures") },
      restores: restoresFinding(down("the restores' checkpoint")),
      reconciliation: { status: down("the ledger") },
      rotation: { status: down("the keys") },
      tenant: down("the tenant keys"),
      forgottenTenant: down("the forgotten tenant's ledger"),
      retention: { status: down("the persons") },
      recipients: down("the recipients"),
    });
    expect(status).toEqual({
      schema: [
        ...schemaOf(
          { database: "storage", adapter: storage, scopes: ["storage", "checkpoints"] },
          await storage.schemaVersions(),
        ),
        { database: "readModels.reports", unreadable: true },
      ],
      restoresFound: { unreadable: true },
      lag: { unreadable: true },
      subscriberFailures: { unreadable: true },
      personalDataBackfill: { unreadable: true },
      forgetLedger: { unreadable: true },
      tenant: { unreadable: true },
      forgottenTenant: { unreadable: true },
      keyRotation: { unreadable: true },
      retention: { unreadable: true },
      deadLetterRetention: null,
      subscriberFailureRetention: null,
      recipients: { unreadable: true },
      files: [],
    });
    expect(status.schema.length).toBeGreaterThan(1);
    expect(
      entries.map(({ level, message, fields }) => [
        level,
        message,
        fields?.part,
        fields?.database,
        fields?.errorMessage,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [
          "error",
          "a part of the status could not be read",
          "schema",
          "readModels.reports",
          "the reports database is down",
        ],
        [
          "error",
          "a part of the status could not be read",
          "restoresFound",
          undefined,
          "the restores' checkpoint is down",
        ],
        [
          "error",
          "a part of the status could not be read",
          "lag",
          undefined,
          "the event store is down",
        ],
        [
          "error",
          "a part of the status could not be read",
          "subscriberFailures",
          undefined,
          "the failures is down",
        ],
        [
          "error",
          "a part of the status could not be read",
          "personalDataBackfill",
          undefined,
          "the backfill's checkpoints is down",
        ],
        [
          "error",
          "a part of the status could not be read",
          "forgetLedger",
          undefined,
          "the ledger is down",
        ],
        [
          "error",
          "a part of the status could not be read",
          "keyRotation",
          undefined,
          "the keys is down",
        ],
        [
          "error",
          "a part of the status could not be read",
          "tenant",
          undefined,
          "the tenant keys is down",
        ],
        [
          "error",
          "a part of the status could not be read",
          "forgottenTenant",
          undefined,
          "the forgotten tenant's ledger is down",
        ],
        [
          "error",
          "a part of the status could not be read",
          "retention",
          undefined,
          "the persons is down",
        ],
        [
          "error",
          "a part of the status could not be read",
          "recipients",
          undefined,
          "the recipients is down",
        ],
      ]),
    );
    expect(entries).toHaveLength(11);
    expect(unreadableParts(status)).toEqual([
      "schema (readModels.reports)",
      "restoresFound",
      "lag",
      "subscriberFailures",
      "personalDataBackfill",
      "forgetLedger",
      "tenant",
      "forgottenTenant",
      "keyRotation",
      "retention",
      "recipients",
    ]);
  });

  it("reads each part through its store, `null` or empty for one the app does not have", async () => {
    const status = await readAppStatus({
      config: tableless,
      logger: silentLogger,
      lag: async () => lagOf([]),
      failures: await failuresOf([]),
      restores: restoresFinding(async () => 2),
    });
    expect(status).toMatchObject({
      restoresFound: 2,
      personalDataBackfill: null,
      forgetLedger: null,
      tenant: null,
      forgottenTenant: null,
      keyRotation: null,
      retention: null,
      recipients: [],
    });
    expect(unreadableParts(status)).toEqual([]);
    const backfilled = await readAppStatus({
      config: tableless,
      logger: silentLogger,
      lag: async () => lagOf([]),
      backfill: async () => ({ position: 4, caughtUp: true }),
      failures: await failuresOf([]),
      restores: restoresFinding(async () => 0),
    });
    expect(backfilled.personalDataBackfill).toEqual({ position: 4, caughtUp: true });
  });
});

describe("unreadableParts", () => {
  it("names the purges whose store could not be read", () => {
    const read = {
      schema: [],
      restoresFound: 0,
      lag: lagOf([]),
      subscriberFailures: [],
      personalDataBackfill: null,
      forgetLedger: null,
      tenant: null,
      forgottenTenant: null,
      keyRotation: null,
      retention: null,
      deadLetterRetention: null,
      subscriberFailureRetention: null,
      recipients: [],
      files: [],
    } satisfies AppStatus;
    expect(unreadableParts(read)).toEqual([]);
    expect(
      unreadableParts({
        ...read,
        deadLetterRetention: { retentionMs: 1, unreadable: true },
        subscriberFailureRetention: { retentionMs: 1, unreadable: true },
      }),
    ).toEqual(["deadLetterRetention", "subscriberFailureRetention"]);
  });
});
