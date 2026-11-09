import { expect } from "vitest";
import type { Storage } from "../adapter.ts";
import type { EarlierTables, EarlierVersion } from "./earlier-schemas.ts";
import {
  testKeyedPerson as held,
  testContext,
  testMetadata,
  testOutcome,
  testPersonalKey,
} from "./fixtures.ts";

// Rows as released versions wrote them, in SQL that SQLite and PostgreSQL both take. Frozen, like
// the tables they go in.

const json = (value: unknown): string => `'${JSON.stringify(value)}'`;

const PROCESS_STACK = "TypeError: card of Ada declined\n    at pay (pay.js:1:1)";

const SCHEDULED_PAYLOAD = { customer: "Ada" };

export interface EarlierRowsForFunction {
  (version: EarlierVersion, t: EarlierTables): readonly string[];
}

export const earlierRowsFor: EarlierRowsForFunction = (version, t) => {
  const named = version === "0.3.0";
  const persons = json([held("p-2", "1")]);
  const letter = (columns: Record<string, string>) =>
    `INSERT INTO ${t.deadLetters} (${Object.keys(columns)
      .map((column) => `"${column}"`)
      .join(", ")}) VALUES (${Object.values(columns).join(", ")})`;
  const letterColumns = {
    kind: "'policy'",
    handler: "'order.notify'",
    event_id: "'e-1'",
    event_type: "'OrderPlaced'",
    aggregate_type: "'order'",
    aggregate_id: "'1'",
    error_type: "'terminal'",
    attempts: "1",
    first_failed_at: "'2026-01-01T00:00:00.000Z'",
  };
  return [
    `INSERT INTO ${t.events} ("id", "aggregate_type", "aggregate_id", "version", "type", "payload", "timestamp", "metadata") VALUES
      ('e-1', 'order', '1', 1, 'OrderPlaced', ${json({ total: 5 })}, '2026-01-01T00:00:00.000Z', ${json(testMetadata)}),
      ('e-2', 'order', '1', 2, 'ScheduledCommandFailed', ${json({ commandType: "PlaceOrder", error: "address of Ada", attempts: 3 })}, '2026-01-01T00:01:00.000Z', ${json({ ...testMetadata, system: true })}),
      ('e-3', 'process:order.payment', 'i-1', 1, 'ProcessFailed', ${json({ eventId: "e-1", error: "card of Ada declined", letterId: "dl-process" })}, '2026-01-01T00:02:00.000Z', ${json({ ...testMetadata, system: true })}),
      ('e-4', 'bounda', 'p-1', 1, 'PersonalDataForgotten', ${json({ personId: "p-1", cancelledCommands: [], removedDeadLetters: [] })}, '2026-01-01T00:03:00.000Z', ${json({ ...testMetadata, system: true })})`,
    `INSERT INTO ${t.checkpoints} ("subscriber", "position") VALUES ('projection:x', 4)`,
    `INSERT INTO ${t.inbox} ("handler", "event_id", "status", "attempts", "claimed_at", "last_error") VALUES ('order.notify', 'e-1', 'claimed', 2, '2026-01-01T00:00:00.000Z', 'mail to Ada bounced')`,
    letter({
      id: "'dl-process'",
      ...letterColumns,
      kind: "'process'",
      handler: "'order.payment'",
      error_message: "'card of Ada declined'",
      error_stack: `'${PROCESS_STACK}'`,
      last_failed_at: "'2026-01-01T00:02:00.000Z'",
      status: "'failed'",
    }),
    letter({
      id: "'dl-bare'",
      ...letterColumns,
      error_message: "''",
      error_stack: "'RangeError\r\n    at f (f.js:1:1)'",
      last_failed_at: "'2026-01-01T00:00:00.000Z'",
      status: "'failed'",
    }),
    letter({
      id: "'dl-odd'",
      ...letterColumns,
      error_message: "'thrown'",
      error_stack: "'not a name: thrown'",
      last_failed_at: "'2026-01-01T00:00:00.000Z'",
      status: "'failed'",
    }),
    letter({
      id: "'dl-resolved'",
      ...letterColumns,
      error_message: "'boom'",
      last_failed_at: "'2026-01-02T00:00:00.000Z'",
      status: "'discarded'",
    }),
    ...(named
      ? [
          letter({
            id: "'dl-scheduled'",
            ...letterColumns,
            kind: "'scheduled'",
            handler: "'PlaceOrder'",
            error_message: "'{\"quoted\": true}'",
            last_failed_at: "'2026-01-01T00:00:00.000Z'",
            status: "'failed'",
            payload: json(SCHEDULED_PAYLOAD),
            persons,
          }),
        ]
      : []),
    `INSERT INTO ${t.scheduledCommands} ("dedupe_key", "command_type", "aggregate_id", "payload", "execute_at", "context", "attempts", "last_error"${named ? ', "persons"' : ""}) VALUES ('s-1', 'PlaceOrder', '1', ${json(SCHEDULED_PAYLOAD)}, '2026-02-01T00:00:00.000Z', ${json(testContext)}, 1, 'address of Ada'${named ? `, ${persons}` : ""})`,
    ...(named
      ? [
          `INSERT INTO ${t.idempotencyKeys} ("key", "fingerprint", "outcome", "expires_at", "persons") VALUES ('k-1', 'fp', ${json(testOutcome("1"))}, '2099-01-01T00:00:00.000Z', ${persons})`,
          `INSERT INTO ${t.personalKeys} ("person", "key", "fingerprint") VALUES ('p-2', '${testPersonalKey("1").key}', '${testPersonalKey("1").fingerprint}')`,
          `INSERT INTO ${t.snapshots} ("aggregate_type", "aggregate_id", "version", "fingerprint", "state", "persons") VALUES ('order', '1', 1, 'fp', '{}', ${persons})`,
        ]
      : []),
  ];
};

export interface ExpectEarlierRowsTakenInArgs {
  readonly storage: Storage;
  readonly version: EarlierVersion;
  readonly execute: (statement: string) => Promise<readonly Record<string, unknown>[]>;
  readonly tables: EarlierTables;
}

export interface ExpectEarlierRowsTakenInFunction {
  (args: ExpectEarlierRowsTakenInArgs): Promise<void>;
}

/**
 * What the current stores read of `earlierRowsFor`: every row, with what its new columns would
 * have held, and no error text left in the clear outside the dead letters.
 */
export const expectEarlierRowsTakenIn: ExpectEarlierRowsTakenInFunction = async ({
  storage,
  version,
  execute,
  tables,
}) => {
  expect(await storage.checkpointStore.get("projection:x")).toBe(4);
  const events = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
  expect(events.map(({ id, type, payload, person }) => ({ id, type, payload, person }))).toEqual([
    { id: "e-1", type: "OrderPlaced", payload: { total: 5 }, person: null },
    {
      id: "e-2",
      type: "ScheduledCommandFailed",
      payload: { commandType: "PlaceOrder", errorName: "Error", attempts: 3 },
      person: null,
    },
    {
      id: "e-3",
      type: "ProcessFailed",
      payload: { eventId: "e-1", errorName: "TypeError", letterId: "dl-process" },
      person: null,
    },
    {
      id: "e-4",
      type: "PersonalDataForgotten",
      payload: {
        personId: "p-1",
        reason: "requested",
        cancelledCommands: [],
        removedDeadLetters: [],
      },
      person: "p-1",
    },
  ]);
  expect(events[0]?.metadata).toEqual(testMetadata);
  expect(await storage.deadLetterStore.get("dl-process")).toMatchObject({
    status: "failed",
    person: null,
    errorName: "TypeError",
    errorMessage: "card of Ada declined",
    errorStack: PROCESS_STACK,
  });
  expect(await storage.deadLetterStore.get("dl-process")).not.toHaveProperty("resolvedAt");
  expect(await storage.deadLetterStore.get("dl-bare")).toMatchObject({
    errorName: "RangeError",
    errorMessage: "",
    errorStack: "RangeError\r\n    at f (f.js:1:1)",
  });
  expect(await storage.deadLetterStore.get("dl-odd")).toMatchObject({
    errorName: "Error",
    errorStack: "not a name: thrown",
  });
  expect(await storage.deadLetterStore.get("dl-resolved")).toMatchObject({
    status: "discarded",
    errorName: "Error",
    errorMessage: "boom",
    resolvedAt: "2026-01-02T00:00:00.000Z",
  });
  expect(await storage.deadLetterStore.firstResolvedAt()).toEqual(
    new Date("2026-01-02T00:00:00.000Z"),
  );
  expect(
    await storage.inboxLedger.get({ handler: "order.notify", eventId: "e-1" }),
  ).not.toHaveProperty("lastError");
  expect(
    await execute(
      `SELECT "last_error" FROM ${tables.scheduledCommands} WHERE "dedupe_key" = 's-1'`,
    ),
  ).toEqual([{ last_error: null }]);
  const [scheduled] = await storage.scheduler.list();
  expect(scheduled).toMatchObject({
    dedupeKey: "s-1",
    command: { type: "PlaceOrder", aggregateId: "1", payload: SCHEDULED_PAYLOAD },
    context: testContext,
  });
  if (version === "0.2.0") return;
  // The rows that name a person are found by them, as the current stores look them up.
  expect(await storage.deadLetterStore.get("dl-scheduled")).toMatchObject({
    errorName: "Error",
    errorMessage: '{"quoted": true}',
    payload: SCHEDULED_PAYLOAD,
  });
  expect((await storage.deadLetterStore.listByPerson("p-2")).map(({ id }) => id)).toEqual([
    "dl-scheduled",
  ]);
  expect((await storage.scheduler.listByPerson("p-2")).map(({ dedupeKey }) => dedupeKey)).toEqual([
    "s-1",
  ]);
  expect(await storage.personalKeys.get("p-2")).toEqual(testPersonalKey("1"));
  expect(
    await storage.snapshotStore.get({ aggregateType: "order", aggregateId: "1" }),
  ).not.toBeNull();
  await storage.snapshotStore.forget("p-2");
  expect(await storage.snapshotStore.get({ aggregateType: "order", aggregateId: "1" })).toBeNull();
  await storage.idempotencyStore.forget("p-2");
  expect(
    await execute(`SELECT count(*) AS "left" FROM ${tables.idempotencyKeys}`).then(([row]) =>
      Number(row?.left),
    ),
  ).toBe(0);
};
