import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { IdempotentAnswerErasedError, ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { expectForgotten } from "../../testing/expect-forgotten.ts";
import { createApp } from "../app.ts";
import { BACKFILL_FOLLOW_INTERVAL_MS, BACKFILL_LEASE_MS, BACKFILL_PREFIX } from "./backfill.ts";

const START = new Date("2026-05-01T00:00:00.000Z");
const MINUTE_MS = 60_000;

type Builders = Record<string, (payload?: unknown) => unknown>;

interface Follow {
  readonly agentId: string | null;
  readonly agentPhone: string | null;
}

// Version 1 marks nothing and stores the contact's address as `mail`; version 2 marks it, under
// the name `email` an upcast gives it, and the agent of the process's state.
const registryOf = (version: 1 | 2): Registry => {
  const marked = version === 2;
  return {
    aggregates: {
      contact: {
        state: { initialState: {} },
        events: {
          contactAdded: {
            payload: ({ z, person, personal, notPersonal }: EventPayloadArgs) =>
              marked
                ? z.object({ personId: person(z.string()), email: personal(z.email()) })
                : z.object({ personId: notPersonal(z.string()), mail: notPersonal(z.email()) }),
            evolve: () => ({}),
          },
          contactNoted: {
            payload: ({ z, person, personal, notPersonal }: EventPayloadArgs) =>
              z.object({
                personId: marked ? person(z.string()) : notPersonal(z.string()),
                note: marked ? personal(z.string()) : notPersonal(z.string()),
              }),
            evolve: () => ({}),
          },
        },
        ...(marked
          ? {
              upcasts: {
                contactAdded: {
                  upcasts: [
                    (payload: { personId: string; mail: string | null }) => ({
                      personId: payload.personId,
                      email: payload.mail,
                    }),
                  ],
                },
              },
            }
          : {}),
        commands: {
          addContact: {
            module: {
              payload: ({ z, notPersonal }: CommandPayloadArgs) =>
                z.object({
                  contactId: notPersonal(z.string()),
                  personId: notPersonal(z.string()),
                  email: notPersonal(z.email()),
                }),
              handler: ({
                command,
                events,
              }: {
                command: { payload: { personId: string; email: string } };
                events: Builders;
              }) => [
                marked
                  ? events.contactAdded?.({
                      personId: command.payload.personId,
                      email: command.payload.email,
                    })
                  : events.contactAdded?.({
                      personId: command.payload.personId,
                      mail: command.payload.email,
                    }),
              ],
            },
          },
          noteContact: {
            module: {
              payload: ({ z, notPersonal }: CommandPayloadArgs) =>
                z.object({
                  contactId: notPersonal(z.string()),
                  personId: notPersonal(z.string()),
                  note: notPersonal(z.string()),
                }),
              handler: ({
                command,
                events,
              }: {
                command: { payload: { personId: string; note: string } };
                events: Builders;
              }) => [
                events.contactNoted?.({
                  personId: command.payload.personId,
                  note: command.payload.note,
                }),
              ],
            },
          },
          remindContact: {
            module: {
              payload: ({ z, personal, notPersonal }: CommandPayloadArgs) =>
                z.object({
                  contactId: notPersonal(z.string()),
                  personId: notPersonal(z.string()),
                  email: marked ? personal(z.email()) : notPersonal(z.email()),
                }),
              handler: () => [],
            },
          },
        },
        policies: {},
        processes: {
          follow: {
            module: {
              config: ({
                events,
              }: {
                events: { contact: { ContactAdded: string; ContactNoted: string } };
              }) => ({
                startedBy: [events.contact.ContactAdded],
                completedBy: [],
                timeout: "48h",
              }),
              state: ({ z, person, personal, notPersonal }: EventPayloadArgs) =>
                z.object({
                  agentId: (marked ? person(z.string()) : notPersonal(z.string()))
                    .nullable()
                    .default(null),
                  agentPhone: (marked ? personal(z.string()) : notPersonal(z.string()))
                    .nullable()
                    .default(null),
                }),
            },
            handlers: {
              contact: {
                contactAdded: {
                  handler: () => ({ agentId: "a-1", agentPhone: "+34 600 000 000" }),
                },
                contactNoted: {
                  handler: ({ state }: { state: Follow }) => {
                    throw new ValidationError(`agent ${state.agentPhone ?? "nobody"} is away`, []);
                  },
                },
              },
            },
          },
        },
      },
    },
    readModels: {},
  } as unknown as Registry;
};

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

let starts = 0;

const start = async (adapter: Adapter, version: 1 | 2, now: Date = START) => {
  starts += 1;
  const clock = createFixedClock(now);
  const app = await createApp({
    registry: registryOf(version),
    config: {
      storage: adapter,
      runtime: { processes: { retry: { strategy: "none" } } },
    },
    ids: createSequentialIdGenerator({ prefix: `app-${starts}` }),
    clock,
    logger: silentLogger,
  });
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await app.stop();
  };
  stops.push(stop);
  const commands = app.commands as unknown as Record<
    string,
    (
      payload: unknown,
      options?: { readonly delay?: string; readonly idempotencyKey?: string },
    ) => Promise<unknown>
  >;
  return { app, clock, commands, stop };
};

const later = (clock: { now(): Date }, ms = MINUTE_MS): Date =>
  new Date(clock.now().getTime() + ms);

const added = async (adapter: Adapter): Promise<StoredEvent | undefined> =>
  (await (await adapter.createStorage()).eventStore.readAll({ afterPosition: 0, limit: 100 })).find(
    (event) => event.type === "ContactAdded",
  );

const adapters: readonly [string, () => Adapter][] = [
  ["memory", () => memory()],
  ["SQLite (node:sqlite)", () => createNodeSqliteAdapter().adapter],
];

describe.each(adapters)("what the backfill closes on %s", (_name, adapterOf) => {
  it("rewrites an event stored in an older shape in its current one, sealed, so a forget reaches it", async () => {
    const adapter = adapterOf();
    const before = await start(adapter, 1);
    await before.commands.addContact?.({
      contactId: "x-1",
      personId: "p-1",
      email: "ana@example.com",
    });
    await before.stop();
    expect((await added(adapter))?.metadata.schemaVersion).toBe(1);

    const after = await start(adapter, 2, later(before.clock));
    await after.app.runUntilIdle();
    const rewritten = await added(adapter);
    expect(rewritten?.metadata.schemaVersion).toBe(2);
    expect(rewritten?.person).toBe("p-1");
    expect(rewritten?.payload).toEqual({
      personId: "p-1",
      email: expect.objectContaining({ $personal: expect.objectContaining({ person: "p-1" }) }),
    });
    expect((await after.app.exportPersonalData("p-1")).events[0]?.data).toEqual({
      email: "ana@example.com",
    });
    expect(await after.app.getLag()).toMatchObject({ personalDataBackfill: { caughtUp: true } });

    await after.app.forget("p-1");
    await expectForgotten(adapter, "p-1", { values: ["ana@example.com"] });
  });

  it("leaves the shape while an instance on other marks runs, and rewrites it once that instance stops", async () => {
    const adapter = adapterOf();
    const before = await start(adapter, 1);
    await before.commands.addContact?.({
      contactId: "x-1",
      personId: "p-1",
      email: "ana@example.com",
    });
    await before.stop();
    const now = later(before.clock);
    const storage = await adapter.createStorage();
    await storage.checkpointStore.set(
      `${BACKFILL_PREFIX}older:lease`,
      now.getTime() + BACKFILL_LEASE_MS,
    );

    const after = await start(adapter, 2, now);
    await after.app.runUntilIdle();
    expect((await added(adapter))?.metadata.schemaVersion).toBe(1);
    expect(await after.app.getLag()).toMatchObject({ personalDataBackfill: { caughtUp: false } });

    after.clock.advance(BACKFILL_LEASE_MS + BACKFILL_FOLLOW_INTERVAL_MS);
    await after.app.runUntilIdle();
    expect((await added(adapter))?.metadata.schemaVersion).toBe(2);
    expect(JSON.stringify(await added(adapter))).not.toContain("ana@example.com");
    expect(await after.app.getLag()).toMatchObject({ personalDataBackfill: { caughtUp: true } });
  });

  it("seals for good a scheduled command's fields of a person forgotten after it was scheduled", async () => {
    const adapter = adapterOf();
    const before = await start(adapter, 1);
    await before.commands.remindContact?.(
      { contactId: "x-1", personId: "p-1", email: "ana@example.com" },
      { delay: "7d" },
    );
    before.clock.advance(MINUTE_MS);
    await before.app.forget("p-1");
    await before.stop();

    const after = await start(adapter, 2, later(before.clock));
    await after.commands.addContact?.({
      contactId: "x-2",
      personId: "p-1",
      email: "ana@new.example",
    });
    await after.app.runUntilIdle();
    const storage = await adapter.createStorage();
    const entry = (await storage.scheduler.list()).find(
      ({ command }) => command.type === "RemindContact",
    );
    expect(entry?.scheduledAt).toBe(START.toISOString());
    const held = (await storage.personalKeys.list("p-1")).map(({ key }) => key.fingerprint);
    expect(held).not.toEqual([]);
    const payload = entry?.command.payload as
      | { readonly email: { readonly $personal: { readonly key: string } } }
      | undefined;
    expect(payload?.email.$personal.key).toBeDefined();
    expect(held).not.toContain(payload?.email.$personal.key);
    expect((await after.app.exportPersonalData("p-1")).scheduledCommands).toEqual([]);
  });

  it("names the person of a process letter's state, and seals its text under them, for a letter filed before the marks", async () => {
    const adapter = adapterOf();
    const before = await start(adapter, 1);
    await before.commands.addContact?.({
      contactId: "x-1",
      personId: "p-1",
      email: "ana@example.com",
    });
    await before.commands.noteContact?.({ contactId: "x-1", personId: "p-1", note: "call back" });
    await before.app.runUntilIdle();
    await before.stop();
    const storage = await adapter.createStorage();
    const [filed] = await storage.deadLetterStore.list({ kind: "process" });
    expect(filed).toMatchObject({ person: null, errorMessage: "agent +34 600 000 000 is away" });

    const after = await start(adapter, 2, later(before.clock));
    await after.app.runUntilIdle();
    const resealed = await storage.deadLetterStore.get(filed?.id ?? "");
    expect(resealed).toMatchObject({ person: "p-1", statePerson: "a-1" });
    expect(resealed?.errorMessage).toMatchObject({ $personal: { person: "a-1" } });
    expect(JSON.stringify(resealed)).not.toContain("600 000");
    expect(
      (await after.app.exportPersonalData("a-1", { includeWithheld: true })).deadLetters,
    ).toEqual([expect.objectContaining({ errorMessage: "agent +34 600 000 000 is away" })]);
    await after.app.forget("a-1");
    expect((await after.app.deadLetters.get(filed?.id ?? ""))?.errorMessage).toBeNull();
  });

  it("erases the answers remembered under other marks, which a retry then finds erased", async () => {
    const adapter = adapterOf();
    const before = await start(adapter, 1);
    await before.commands.addContact?.(
      { contactId: "x-1", personId: "p-1", email: "ana@example.com" },
      { idempotencyKey: "add-1" },
    );
    await before.stop();

    const after = await start(adapter, 2, later(before.clock));
    const storage = await adapter.createStorage();
    // Refused before the walk erases it: it was sealed under other marks.
    await expect(
      after.commands.addContact?.(
        { contactId: "x-1", personId: "p-1", email: "ana@example.com" },
        { idempotencyKey: "add-1" },
      ),
    ).rejects.toBeInstanceOf(IdempotentAnswerErasedError);
    expect(
      (await storage.idempotencyStore.list({ now: after.clock.now() }))[0]?.answer,
    ).not.toBeNull();
    await after.app.runUntilIdle();
    const records = await storage.idempotencyStore.list({ now: after.clock.now() });
    expect(records).toEqual([expect.objectContaining({ answer: null, persons: [] })]);
    await expect(
      after.commands.addContact?.(
        { contactId: "x-1", personId: "p-1", email: "ana@example.com" },
        { idempotencyKey: "add-1" },
      ),
    ).rejects.toBeInstanceOf(IdempotentAnswerErasedError);
  });
});
