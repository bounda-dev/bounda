import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DeadLetterNotRetriableError, ValidationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { PersonalDataForgottenEvent } from "../../modules/bounda-events.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import { person, personal } from "../../modules/personal.ts";
import type { Registry } from "../../modules/registry.ts";
import { createTestApp } from "../../testing/index.ts";
import { createRecordingLogger } from "../test-support.ts";
import { openCommandPayload, sealCommandPayload } from "./commands.ts";
import { generatePersonalKey, isSealed } from "./crypto.ts";
import { personalMarksOf } from "./marks.ts";

const received: unknown[] = [];
// Runs inside `remindCustomer`'s handler once, before it answers.
let whileRunning: (() => Promise<unknown>) | null = null;
let failing = false;

type Builders = Record<string, (payload?: unknown) => unknown>;

const registry = {
  aggregates: {
    customer: {
      events: {
        customerInvited: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ email: personal(z.email()) }),
          evolve: () => ({}),
        },
        customerReminded: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ to: personal(z.email()) }),
          evolve: () => ({}),
        },
      },
      commands: {
        remindCustomer: {
          module: {
            payload: ({ z, personal }: CommandPayloadArgs) =>
              z.object({ customerId: z.string(), email: personal(z.email()) }),
            handler: async ({
              command,
              events,
            }: {
              command: { payload: { email: string } };
              events: Builders;
            }) => {
              received.push(command.payload);
              const run = whileRunning;
              whileRunning = null;
              await run?.();
              if (failing) throw new ValidationError("the mail server refused it", []);
              return [events.customerReminded?.({ to: command.payload.email })];
            },
          },
        },
        inviteCustomer: {
          module: {
            payload: ({ z, personal }: CommandPayloadArgs) =>
              z.object({ customerId: z.string(), email: personal(z.email()) }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string } };
              events: Builders;
            }) => [events.customerInvited?.({ email: command.payload.email })],
          },
        },
        introduceFriend: {
          module: {
            payload: ({ z, personal, person }: CommandPayloadArgs) =>
              z.object({
                customerId: z.string(),
                friendId: person(z.string()),
                note: personal(z.string()).optional(),
              }),
            handler: ({ command }: { command: { payload: unknown } }) => {
              received.push(command.payload);
              return [];
            },
          },
        },
      },
      policies: {
        remindOnCustomerInvited: {
          module: {
            on: "CustomerInvited",
            handler: async ({
              event,
              commands,
            }: {
              event: { aggregateId: string; payload: { email: string | null } };
              commands: Record<string, (payload: unknown, options: unknown) => Promise<unknown>>;
            }) => {
              if (event.payload.email === null) return;
              await commands.remindCustomer?.(
                { customerId: event.aggregateId, email: event.payload.email },
                { delay: "1m" },
              );
            },
          },
          source: "customer",
        },
      },
      processes: {},
    },
  },
  readModels: {},
} as const satisfies Registry;

const ana = { customerId: "c-1", email: "ana@example.com" };

const setup = async () => {
  received.length = 0;
  whileRunning = null;
  failing = false;
  const adapter = memory();
  const storage = await adapter.createStorage({ logger: silentLogger });
  const { logger, entries: logs } = createRecordingLogger();
  const { app, clock } = await createTestApp({ registry, adapter, logger });
  const runDue = async () => {
    clock.advance(60_000);
    await app.runUntilIdle();
  };
  const forgottenPayload = async () => {
    const events = await app.events.read();
    const forgotten = events.filter((event) => event.type === "PersonalDataForgotten");
    return (forgotten.at(-1) as PersonalDataForgottenEvent | undefined)?.payload;
  };
  return { app, storage, logs, runDue, forgottenPayload };
};

describe("sealCommandPayload and openCommandPayload", () => {
  const marks = (shape: z.ZodRawShape) =>
    personalMarksOf({ schema: z.object(shape), path: "aggregates.customer.commands.c" });

  it("seals the marked fields with the key of the aggregate's person, creating it", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    const sealed = await sealCommandPayload({
      type: "RemindCustomer",
      aggregateId: "c-1",
      payload: { customerId: "c-1", email: "ana@example.com" },
      marks: marks({ customerId: z.string(), email: personal(z.email()) }),
      keys: storage.personalKeys,
    });
    const key = await storage.personalKeys.get("c-1");
    expect(sealed.persons).toEqual([{ person: "c-1", fingerprint: key?.fingerprint }]);
    const payload = sealed.payload as { customerId: unknown; email: unknown };
    expect(payload.customerId).toBe("c-1");
    expect(isSealed(payload.email)).toBe(true);
    expect(await openCommandPayload({ payload, keys: storage.personalKeys })).toEqual({
      payload: { customerId: "c-1", email: "ana@example.com" },
      forgotten: false,
    });
  });

  it("seals under the person a field names, and keeps the key in force", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    const kept = await storage.personalKeys.add("f-1", await generatePersonalKey());
    const sealed = await sealCommandPayload({
      type: "IntroduceFriend",
      aggregateId: "c-1",
      payload: { customerId: "c-1", friendId: "f-1", note: "old friend" },
      marks: marks({ friendId: person(z.string()), note: personal(z.string()) }),
      keys: storage.personalKeys,
    });
    expect(sealed.persons).toEqual([{ person: "f-1", fingerprint: kept.fingerprint }]);
    expect(await storage.personalKeys.get("c-1")).toBeNull();
  });

  it("leaves a payload with nothing to seal as it is, naming no one and keying no one", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    const shape = { friendId: person(z.string()), note: personal(z.string()).optional() };
    for (const [payload, payloadMarks] of [
      [{ friendId: "f-1" }, marks(shape)],
      [{ friendId: "f-1", note: "hi" }, null],
      ["not an object", marks(shape)],
    ] as const) {
      expect(
        await sealCommandPayload({
          type: "IntroduceFriend",
          aggregateId: "c-1",
          payload,
          marks: payloadMarks,
          keys: storage.personalKeys,
        }),
      ).toEqual({ payload, persons: [] });
    }
    expect(await storage.personalKeys.get("f-1")).toBeNull();
  });

  it.each([undefined, "", 42n])(
    "refuses a person field that names no one: %s",
    async (friendId) => {
      const storage = await memory().createStorage({ logger: silentLogger });
      await expect(
        sealCommandPayload({
          type: "IntroduceFriend",
          aggregateId: "c-1",
          payload: { friendId, note: "hi" },
          marks: marks({ friendId: person(z.string()), note: personal(z.string()) }),
          keys: storage.personalKeys,
        }),
      ).rejects.toThrow(
        new ValidationError('Command IntroduceFriend names no person in "friendId"', [
          { path: ["friendId"], message: "Expected a non-empty string" },
        ]),
      );
    },
  );

  it("opens to null, telling it forgotten, a field whose key is gone or was replaced", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    const { payload } = await sealCommandPayload({
      type: "RemindCustomer",
      aggregateId: "c-1",
      payload: { email: "ana@example.com", plan: "pro" },
      marks: marks({ email: personal(z.email()), plan: z.string() }),
      keys: storage.personalKeys,
    });
    await storage.personalKeys.remove("c-1");
    const forgotten = { payload: { email: null, plan: "pro" }, forgotten: true };
    expect(await openCommandPayload({ payload, keys: storage.personalKeys })).toEqual(forgotten);
    await storage.personalKeys.add("c-1", await generatePersonalKey());
    expect(await openCommandPayload({ payload, keys: storage.personalKeys })).toEqual(forgotten);
  });

  it("names a person by a numeric id, as text", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    const sealed = await sealCommandPayload({
      type: "IntroduceFriend",
      aggregateId: "c-1",
      payload: { friendId: 7, note: "hi" },
      marks: marks({ friendId: person(z.number()), note: personal(z.string()) }),
      keys: storage.personalKeys,
    });
    expect(sealed.persons.map((held) => held.person)).toEqual(["7"]);
  });

  it("reads each person's key once, and opens each field under its own person's key", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    const shape = {
      friendId: person(z.string()),
      a: personal(z.string()),
      b: personal(z.string()),
    };
    const sealedFor = async (friendId: string, a: string, b: string) =>
      (
        await sealCommandPayload({
          type: "IntroduceFriend",
          aggregateId: "c-1",
          payload: { friendId, a, b },
          marks: marks(shape),
          keys: storage.personalKeys,
        })
      ).payload as Record<string, unknown>;
    const ana = await sealedFor("f-1", "a1", "b1");
    const bo = await sealedFor("f-2", "a2", "b2");
    const reads: string[] = [];
    const keys = {
      ...storage.personalKeys,
      get: (person: string) => {
        reads.push(person);
        return storage.personalKeys.get(person);
      },
    };
    expect(await openCommandPayload({ payload: ana, keys })).toEqual({
      payload: { friendId: "f-1", a: "a1", b: "b1" },
      forgotten: false,
    });
    expect(reads).toEqual(["f-1"]);
    expect(await openCommandPayload({ payload: { a: ana.a, b: bo.b }, keys })).toEqual({
      payload: { a: "a1", b: "b2" },
      forgotten: false,
    });
  });

  it("opens a payload that holds nothing sealed as it is", async () => {
    const storage = await memory().createStorage({ logger: silentLogger });
    for (const payload of [{ email: "ana@example.com" }, "text", null]) {
      expect(await openCommandPayload({ payload, keys: storage.personalKeys })).toEqual({
        payload,
        forgotten: false,
      });
    }
  });
});

describe("personal data in delayed commands", () => {
  it("stores a delayed command's personal fields sealed and runs it with them in the clear", async () => {
    const { app, storage, runDue } = await setup();
    await app.commands.remindCustomer(ana, { delay: "1m" });
    const [entry] = await storage.scheduler.list();
    const key = await storage.personalKeys.get("c-1");
    expect(entry?.persons).toEqual([{ person: "c-1", fingerprint: key?.fingerprint }]);
    expect(isSealed((entry?.command.payload as { email?: unknown } | undefined)?.email)).toBe(true);
    expect(JSON.stringify(entry)).not.toContain("ana@example.com");
    await runDue();
    expect(received).toEqual([ana]);
    expect(await storage.scheduler.list()).toEqual([]);
    await app.stop();
  });

  it("seals what a policy schedules from its unit of work", async () => {
    const { app, storage, runDue } = await setup();
    await app.commands.inviteCustomer(ana);
    await app.runUntilIdle();
    const [entry] = await storage.scheduler.list();
    expect(entry?.command.type).toBe("RemindCustomer");
    expect(entry?.persons?.map((held) => held.person)).toEqual(["c-1"]);
    expect(JSON.stringify(entry)).not.toContain("ana@example.com");
    await runDue();
    expect(received).toEqual([ana]);
    await app.stop();
  });

  it("seals what it stores with an idempotency key too", async () => {
    const { app, storage } = await setup();
    await app.commands.remindCustomer(ana, { delay: "1m", idempotencyKey: "remind-1" });
    expect(JSON.stringify(await storage.scheduler.list())).not.toContain("ana@example.com");
    await app.stop();
  });

  it("cancels a person's delayed commands on forget, and names them in PersonalDataForgotten", async () => {
    const { app, storage, runDue, forgottenPayload } = await setup();
    await app.commands.remindCustomer(ana, { delay: "1m" });
    await app.commands.remindCustomer(
      { customerId: "c-2", email: "bo@example.com" },
      { delay: "1m" },
    );
    await app.commands.introduceFriend(
      { customerId: "c-2", friendId: "c-1", note: "met at school" },
      { delay: "2m" },
    );
    const named = (await storage.scheduler.list()).filter((entry) =>
      entry.persons?.some((held) => held.person === "c-1"),
    );
    expect(named).toHaveLength(2);

    await app.forget("c-1");
    expect(await forgottenPayload()).toEqual({
      personId: "c-1",
      cancelledCommands: named.map((entry) => ({
        commandId: entry.dedupeKey.replace(/^command:/, ""),
        type: entry.command.type,
      })),
      removedDeadLetters: [],
    });
    expect((await storage.scheduler.list()).map((entry) => entry.command.aggregateId)).toEqual([
      "c-2",
    ]);
    await runDue();
    await runDue();
    expect(received).toEqual([{ customerId: "c-2", email: "bo@example.com" }]);
    await app.stop();
  });

  it("dead-letters a delayed command sealed, shows it opened, and removes it on forget", async () => {
    const { app, storage, runDue, forgottenPayload } = await setup();
    failing = true;
    await app.commands.remindCustomer(ana, { delay: "1m" });
    await runDue();
    const [stored] = await storage.deadLetterStore.list();
    const key = await storage.personalKeys.get("c-1");
    expect(stored?.persons).toEqual([{ person: "c-1", fingerprint: key?.fingerprint }]);
    expect(JSON.stringify(stored)).not.toContain("ana@example.com");
    expect(await app.deadLetters.list()).toEqual([{ ...stored, payload: ana }]);
    expect(await app.deadLetters.get(stored?.id ?? "")).toEqual({ ...stored, payload: ana });
    expect(await app.deadLetters.discard(stored?.id ?? "")).toEqual({
      ...stored,
      payload: ana,
      status: "discarded",
    });

    await app.forget("c-1");
    expect(await storage.deadLetterStore.list()).toEqual([]);
    expect(await forgottenPayload()).toEqual({
      personId: "c-1",
      cancelledCommands: [],
      removedDeadLetters: [{ id: stored?.id, commandType: "RemindCustomer" }],
    });
    await app.stop();
  });

  it("retries a dead-lettered delayed command with its payload opened", async () => {
    const { app, runDue } = await setup();
    failing = true;
    await app.commands.remindCustomer(ana, { delay: "1m" });
    await runDue();
    failing = false;
    const [letter] = await app.deadLetters.list();
    expect(await app.deadLetters.retry(letter?.id ?? "")).toMatchObject({
      payload: ana,
      status: "retried",
    });
    expect(received).toEqual([ana, ana]);
    await app.stop();
  });

  it.each([
    ["answers", false],
    ["fails", true],
  ])(
    "writes nothing, no dead letter either, for a run a forget overtakes while its handler %s",
    async (_, fails) => {
      const { app, storage, runDue, forgottenPayload } = await setup();
      failing = fails;
      await app.commands.remindCustomer(ana, { delay: "1m" });
      whileRunning = () => app.forget("c-1");
      await runDue();
      expect(whileRunning).toBeNull();
      expect(received).toEqual([ana]);
      expect((await app.events.read()).map((event) => event.type)).toEqual([
        "PersonalDataForgotten",
      ]);
      expect((await forgottenPayload())?.cancelledCommands).toHaveLength(1);
      expect(await storage.deadLetterStore.list()).toEqual([]);
      expect(await storage.scheduler.list()).toEqual([]);
      await app.stop();
    },
  );

  it("drops, never running it, a delayed command sealed under a key its person no longer holds", async () => {
    const { app, storage, logs, runDue } = await setup();
    await app.commands.remindCustomer(ana, { delay: "1m" });
    await storage.personalKeys.remove("c-1");
    await storage.personalKeys.add("c-1", await generatePersonalKey());
    await runDue();
    expect(received).toEqual([]);
    expect(await storage.scheduler.list()).toEqual([]);
    expect(await storage.deadLetterStore.list()).toEqual([]);
    expect(logs).toContainEqual({
      level: "warn",
      message: "scheduled command dropped: its person was forgotten",
      fields: { command: "RemindCustomer", dedupeKey: expect.stringMatching(/^command:/) },
    });
    await app.stop();
  });

  it("refuses to retry a dead letter whose person was forgotten since, and shows its fields as null", async () => {
    const { app, storage, runDue } = await setup();
    failing = true;
    await app.commands.remindCustomer(ana, { delay: "1m" });
    await runDue();
    failing = false;
    await storage.personalKeys.remove("c-1");
    const [letter] = await app.deadLetters.list();
    expect(letter?.payload).toEqual({ customerId: "c-1", email: null });
    await expect(app.deadLetters.retry(letter?.id ?? "")).rejects.toThrow(
      new DeadLetterNotRetriableError(
        'Command "RemindCustomer" holds personal data of a person forgotten since',
      ),
    );
    expect(received).toEqual([ana]);
    expect((await app.deadLetters.get(letter?.id ?? ""))?.status).toBe("failed");
    await app.stop();
  });

  it("runs a delayed command stored before its fields were marked as it was written, beyond forget's reach", async () => {
    const { app, storage, runDue, forgottenPayload } = await setup();
    await storage.scheduler.schedule({
      dedupeKey: "command:legacy",
      command: { type: "RemindCustomer", aggregateId: "c-1", payload: ana },
      executeAt: new Date("2026-01-01T00:00:30.000Z"),
      context: { correlationId: "legacy", causationId: "legacy", depth: 0 },
    });
    await app.forget("c-1");
    expect((await forgottenPayload())?.cancelledCommands).toEqual([]);
    await runDue();
    expect(received).toEqual([ana]);
    await app.stop();
  });
});
