import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import type { ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { Table } from "../../adapter/storage/table.ts";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { LogFields, Logger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { CommandPayloadArgs, EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { RedactedFields } from "../../modules/redaction.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { createTestApp, expectRedacted } from "../../testing/index.ts";
import { scheduledCommandId } from "../command/pipeline.ts";
import { isSealed } from "./crypto.ts";
import { defineForgetLedger } from "./forget-ledger.ts";
import { redactionScrubKey } from "./redaction.ts";

type Events = Record<string, (payload: unknown) => unknown>;

interface ContactRow {
  readonly customerId: string;
  readonly email?: string | null;
  readonly profile?: unknown;
}

const setEmail = ({ event }: { event: { payload: { email: string | null } } }) => ({
  email: event.payload.email,
});

const registry = {
  personalData: { categories: { profile: { basis: "consent", retention: "2y" } } },
  aggregates: {
    customer: {
      state: { initialState: { email: null } },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({
              email: personal(z.string()),
              note: personal(z.string()).optional(),
              plan: z.string(),
            }),
          evolve: setEmail,
        },
        emailCorrected: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ email: personal(z.string()) }),
          evolve: setEmail,
        },
        personalDataRedacted: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ events: z.array(z.string()), note: personal(z.string()) }),
          evolve: ({ state }: { state: object }) => state,
        },
        emailEchoed: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ email: personal(z.string(), { category: "profile" as never }).nullable() }),
          evolve: ({ state }: { state: object }) => state,
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({
                customerId: z.string(),
                email: z.string(),
                note: z.string().optional(),
                plan: z.string(),
              }),
            handler: ({ command, events }: { command: { payload: object }; events: Events }) => [
              events.customerRegistered?.(command.payload),
            ],
          },
        },
        correctEmail: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ customerId: z.string(), email: z.string() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string } };
              events: Events;
            }) => [events.emailCorrected?.({ email: command.payload.email })],
          },
        },
        echoEmail: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
            handler: ({ state, events }: { state: { email: string | null }; events: Events }) => [
              events.emailEchoed?.({ email: state.email }),
            ],
          },
        },
        logRedaction: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
            handler: ({ events }: { events: Events }) => [
              events.personalDataRedacted?.({ events: ["e-1"], note: "n" }),
            ],
          },
        },
        remindCustomer: {
          module: {
            payload: ({ z, personal }: CommandPayloadArgs) =>
              z.object({
                customerId: z.string(),
                email: personal(z.string()),
                note: personal(z.string()),
              }),
            handler: () => [],
          },
        },
      },
      policies: {},
      processes: {
        contactProcess: {
          module: {
            config: ({ events }: { events: { customer: Record<string, string> } }) => ({
              startedBy: [events.customer.CustomerRegistered],
            }),
            state: ({ z, personal }: EventPayloadArgs) =>
              z.object({ contact: personal(z.string()).nullable().default(null) }),
          },
          handlers: {
            customer: {
              customerRegistered: {
                handler: () => ({}),
              },
              emailCorrected: {
                handler: ({ event }: { event: { payload: { email: string | null } } }) => ({
                  contact: event.payload.email,
                }),
              },
            },
          },
        },
      },
    },
  },
  readModels: {
    contacts: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().optional().personal(),
          profile: f.json().optional().personal(),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: ({
              event,
              table,
            }: {
              event: { aggregateId: string; payload: { email: string | null; plan: string } };
              table: Table<ContactRow>;
            }) =>
              table.upsert({
                customerId: event.aggregateId,
                profile: { contact: event.payload.email, plan: event.payload.plan },
              }),
          },
        },
      },
      queries: {
        contact: {
          payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
          handler: ({
            query,
            table,
          }: {
            query: { payload: { customerId: string } };
            table: Table<ContactRow>;
          }) => table.findOne({ customerId: query.payload.customerId }),
        },
      },
    },
  },
} as unknown as Registry;

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

interface Logged {
  readonly level: keyof Logger;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

const setUp = async (batchSize?: number, adapter: Adapter = memory()) => {
  const logged: Logged[] = [];
  const log =
    (level: keyof Logger) =>
    (message: string, fields?: LogFields): void => {
      logged.push({ level, message, fields });
    };
  const entries = new Map<string, ForgetLedgerEntry>();
  // Every entry as it was appended, in order: an intention, then the outbox's copy.
  const appends: ForgetLedgerEntry[] = [];
  const ledger = defineForgetLedger(async () => ({
    append: async (appended) => {
      appends.push(...appended);
      for (const entry of appended) entries.set(entry.eventId, entry);
    },
    read: async ({ limit }) => [...entries.values()].slice(0, limit),
    readMark: async () => 0,
    raiseMark: async () => undefined,
  }));
  const { app, clock } = await createTestApp({
    registry,
    adapter,
    logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    config: {
      runtime: {
        personalData: { forgetLedger: { store: ledger } },
        ...(batchSize === undefined ? {} : { dispatcher: { batchSize } }),
      },
    },
  });
  stops.push(() => app.stop());
  const storage = await adapter.createStorage();
  const commands = app.commands as unknown as Record<
    string,
    (payload: unknown, options?: unknown) => Promise<{ commandId?: string; position: number }>
  >;
  const events = (): Promise<readonly StoredEvent[]> => app.events.read({ limit: 1_000 });
  const redactions = async () =>
    (await events()).filter(({ type }) => type === "PersonalDataRedacted");
  const target = (event: StoredEvent, fields: readonly string[]): RedactedFields => ({
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    type: event.type,
    id: event.id,
    fields,
  });
  const register = async (customerId: string, email: string): Promise<StoredEvent> => {
    await commands.registerCustomer?.({ customerId, email, plan: "pro" });
    const [registered] = (await events()).filter(
      (event) => event.type === "CustomerRegistered" && event.aggregateId === customerId,
    );
    if (registered === undefined) throw new Error("not registered");
    return registered;
  };
  // Appended around the runtime, as an event stored before its fields were marked is.
  const appendRaw = async (customerId: string, person: string, email: unknown) => {
    const { version } = await storage.eventStore.load({
      aggregateType: "customer",
      aggregateId: customerId,
    });
    const [stored] = (
      await storage.eventStore.append({
        aggregateType: "customer",
        aggregateId: customerId,
        expectedVersion: version,
        events: [
          pendingEvent({
            aggregateType: "customer",
            aggregateId: customerId,
            version: version + 1,
            type: "CustomerRegistered",
            payload: { email, plan: "free" },
            id: `raw-${customerId}-${version + 1}`,
            person,
          }),
        ],
      })
    ).events;
    if (stored === undefined) throw new Error("not appended");
    return stored;
  };
  const ledgerRedactions = () => [...entries.values()].filter((entry) => entry.redaction);
  const appendsOf = (eventId: string | undefined) =>
    appends.filter((entry) => entry.eventId === eventId);
  const scrubs = async () =>
    (await storage.scheduler.list()).filter(
      ({ command }) => command.type === "bounda.RedactionScrub",
    );
  return {
    app,
    clock,
    storage,
    commands,
    events,
    redactions,
    target,
    register,
    appendRaw,
    logged,
    entries,
    ledgerRedactions,
    appendsOf,
    scrubs,
  };
};

describe("redact, in detail", () => {
  it("keys its scrub entry by the redaction's event", () => {
    expect(redactionScrubKey("e-1")).toBe("redaction:e-1");
  });

  it("refuses with what it could not reach, and an empty id or no options", async () => {
    const { app, register, target } = await setUp();
    const registered = await register("ana", "ana@old.example");
    await register("bo", "bo@example.com");
    const refused = async (personId: string, options: unknown): Promise<ValidationError> => {
      const error = await app.redact(personId, options as never).catch((caught: unknown) => caught);
      if (!(error instanceof ValidationError)) throw new Error("not refused");
      return error;
    };
    expect((await refused("", { events: [target(registered, ["email"])] })).message).toBe(
      "redact needs the id of the person",
    );
    expect((await refused("ana", undefined)).message).toBe(
      "redact needs the events whose fields to redact",
    );
    const cases: readonly [object, string][] = [
      [{ id: "missing" }, "the store holds no such event"],
      [{ type: "EmailCorrected" }, "it is a CustomerRegistered, not a EmailCorrected"],
    ];
    for (const [changed, why] of cases) {
      const error = await refused("ana", {
        events: [{ ...target(registered, ["email"]), ...changed }],
      });
      const id = (changed as { id?: string }).id ?? registered.id;
      expect(error.message).toBe(`redact cannot reach the event ${id}: ${why}`);
      expect(error.issues).toEqual([{ path: ["events"], message: why }]);
    }
    const other = await refused("bo", { events: [target(registered, ["email"])] });
    expect(other.message).toBe(
      `redact cannot reach the event ${registered.id}: it does not name the person bo`,
    );
  });

  it("answers a redaction with nothing left as a command with no events, at the stream's version", async () => {
    const { app, register, target } = await setUp();
    const registered = await register("ana", "ana@old.example");
    expect(await app.redact("ana", { events: [target(registered, ["note"])] })).toEqual({
      scheduled: false,
      aggregateType: "bounda",
      aggregateId: "ana",
      version: 0,
      eventIds: [],
      eventTypes: [],
      position: 0,
    });
    const first = await app.redact("ana", { events: [target(registered, ["email"])] });
    expect(first).toMatchObject({ scheduled: false, eventTypes: ["PersonalDataRedacted"] });
    expect(await app.redact("ana", { events: [target(registered, ["email"])] })).toEqual({
      ...first,
      eventIds: [],
      eventTypes: [],
      position: 0,
    });
  });

  it("keeps the rest of the payload, names what it reached and logs counts alone", async () => {
    const { app, register, target, redactions, events, logged } = await setUp();
    const registered = await register("ana", "ana@old.example");
    await app.runUntilIdle();
    const moved = await app.redact("ana", {
      events: [target(registered, ["email", "note"])],
    });
    const [stored] = (await events()).filter(({ id }) => id === registered.id);
    expect(stored?.payload).toMatchObject({ plan: "pro" });
    expect(isSealed((stored?.payload as { email?: unknown } | undefined)?.email)).toBe(true);
    expect((await redactions()).map(({ payload }) => payload)).toEqual([
      {
        personId: "ana",
        events: [{ ...target(registered, ["email"]) }],
        categories: ["default"],
        cancelledCommands: [],
        removedDeadLetters: [],
      },
    ]);
    expect(logged.filter(({ message }) => message === "personal data redacted")).toEqual([
      {
        level: "info",
        message: "personal data redacted",
        fields: {
          personId: "ana",
          events: 1,
          fields: 1,
          categories: ["default"],
          cancelledCommands: 0,
          removedDeadLetters: 0,
        },
      },
    ]);
    expect(moved.eventIds).toHaveLength(1);
  });

  it("records the redaction in the ledger before it commits, and nothing more when nothing was written after it", async () => {
    const { app, commands, register, target, ledgerRedactions, appendsOf } = await setUp();
    const registered = await register("ana", "ana@old.example");
    const redacted = await app.redact("ana", {
      events: [target(registered, ["email", "note"])],
    });
    await commands.correctEmail?.({ customerId: "ana", email: "ana@new.example" });
    await app.runUntilIdle();
    // The intention asked for both fields; the outbox copied what the event says it reached.
    const [intention, copy] = appendsOf(redacted.eventIds[0]);
    expect(intention).toEqual({
      personId: "ana",
      categories: null,
      eventId: redacted.eventIds[0],
      forgottenAt: expect.any(String),
      reason: "requested",
      redaction: { events: [target(registered, ["email", "note"])] },
    });
    expect(copy?.redaction).toEqual({ events: [target(registered, ["email"])] });
    expect(ledgerRedactions()).toEqual([
      {
        personId: "ana",
        categories: null,
        eventId: redacted.eventIds[0],
        forgottenAt: expect.any(String),
        reason: "requested",
        redaction: { events: [target(registered, ["email"])] },
      },
    ]);
  });

  it("seals a value held in the clear, and keeps it for the read models only under a key the person holds", async () => {
    const { app, register, appendRaw, target, scrubs } = await setUp();
    await register("ana", "ana@old.example");
    const clear = await appendRaw("ana", "ana", "ana@clear.example");
    await app.redact("ana", { events: [target(clear, ["email"])] });
    expect(await scrubs()).toHaveLength(1);
    await app.runUntilIdle();
    const exported = await app.exportPersonalData("ana");
    expect(exported.events.find(({ id }) => id === clear.id)).toMatchObject({
      data: { email: null },
      redacted: ["email"],
    });
    await expectRedacted(app, "ana", { values: ["ana@clear.example"] });

    const keyless = await appendRaw("zed", "zed", "zed@clear.example");
    const nothingKept = await app.redact("zed", { events: [target(keyless, ["email"])] });
    expect(nothingKept.eventTypes).toEqual(["PersonalDataRedacted"]);
    expect(await scrubs()).toEqual([]);
  });

  it("leaves a value sealed for another person, or no value, as it is", async () => {
    const { app, storage, register, appendRaw, target } = await setUp();
    const bo = await register("bo", "bo@example.com");
    const borrowed = await appendRaw("ana", "ana", (bo.payload as { email: unknown }).email);
    expect((await app.redact("ana", { events: [target(borrowed, ["email"])] })).eventIds).toEqual(
      [],
    );
    const blank = await appendRaw("cy", "cy", null);
    expect((await app.redact("cy", { events: [target(blank, ["email"])] })).eventIds).toEqual([]);
    expect(
      await storage.eventStore.readOne({
        aggregateType: borrowed.aggregateType,
        aggregateId: borrowed.aggregateId,
        eventId: borrowed.id,
      }),
    ).toMatchObject({
      payload: { email: (bo.payload as { email: unknown }).email },
    });
  });

  it("removes the snapshot of every stream it redacted", async () => {
    const { app, storage, register, appendRaw, target } = await setUp();
    const registered = await register("ana", "ana@old.example");
    const elsewhere = await appendRaw("ana-2", "ana", "ana@old.example");
    for (const aggregateId of ["ana", "ana-2"]) {
      await storage.snapshotStore.put({
        aggregateType: "customer",
        aggregateId,
        version: 1,
        state: { email: "ana@old.example" },
        fingerprint: "f",
        persons: [],
      } as never);
    }
    await app.redact("ana", {
      events: [target(registered, ["email"]), target(elsewhere, ["email"])],
    });
    for (const aggregateId of ["ana", "ana-2"]) {
      expect(
        await storage.snapshotStore.get({ aggregateType: "customer", aggregateId }),
      ).toBeNull();
    }
  });

  it("writes null over a value of a read model that holds an old one among others, whichever it is", async () => {
    const { app, commands, register, target, events } = await setUp();
    const registered = await register("ana", "ana@old.example");
    await commands.correctEmail?.({ customerId: "ana", email: "ana@mid.example" });
    const corrected = (await events()).find(({ type }) => type === "EmailCorrected");
    if (corrected === undefined) throw new Error("not corrected");
    await app.runUntilIdle();
    await app.redact("ana", {
      events: [target(registered, ["email"]), target(corrected, ["email"])],
    });
    await app.runUntilIdle();
    expect(
      await (app.queries as unknown as Record<string, (p: unknown) => Promise<unknown>>).contact?.({
        customerId: "ana",
      }),
    ).toEqual({ customerId: "ana" });
  });

  it("cancels a command one of whose fields holds an old value, naming it by its id", async () => {
    const { app, storage, commands, register, target, redactions } = await setUp();
    const registered = await register("ana", "ana@old.example");
    await commands.remindCustomer?.(
      { customerId: "ana", email: "ana@new.example", note: "call ana@old.example" },
      { delay: "1d" },
    );
    await commands.remindCustomer?.(
      { customerId: "ana", email: "ana@new.example", note: "call later" },
      { delay: "2d" },
    );
    const [kept, untouched] = await storage.scheduler.list();
    // A command the app no longer has, and its letter: nothing marks what they hold.
    await storage.scheduler.schedule({
      dedupeKey: "command:gone",
      command: { type: "Gone", aggregateId: "ana", payload: { email: "ana@old.example" } },
      executeAt: new Date("2030-01-01T00:00:00.000Z"),
      context: { correlationId: "c", causationId: "c", depth: 0 },
      persons: [{ person: "ana", fingerprint: null }],
    });
    await storage.deadLetterStore.add({
      id: "gone-letter",
      kind: "scheduled",
      handler: "Gone",
      eventId: "e-0",
      eventType: "Gone",
      aggregateType: "customer",
      aggregateId: "ana",
      person: "ana",
      persons: [{ person: "ana", fingerprint: null }],
      payload: { email: "ana@old.example" },
      errorType: "terminal",
      errorName: "Error",
      errorMessage: "refused",
      attempts: 1,
      firstFailedAt: "2026-01-01T00:00:00.000Z",
      lastFailedAt: "2026-01-01T00:00:00.000Z",
    });
    await app.redact("ana", { events: [target(registered, ["email"])] });
    expect(await storage.deadLetterStore.get("gone-letter")).toMatchObject({
      payload: { email: "ana@old.example" },
      errorMessage: "refused",
    });
    expect((await redactions())[0]?.payload).toMatchObject({
      cancelledCommands: [
        { commandId: scheduledCommandId(kept?.dedupeKey ?? ""), type: "RemindCustomer" },
      ],
    });
    expect(
      (await storage.scheduler.list())
        .map(({ dedupeKey }) => dedupeKey)
        .filter((key) => key.startsWith("command:")),
    ).toEqual([untouched?.dedupeKey, "command:gone"]);
  });

  it("seals for good a letter's text that quotes an old value, its message or its stack, and keeps the rest of it", async () => {
    const { app, storage, register, target } = await setUp();
    const registered = await register("ana", "ana@old.example");
    const letter = (id: string, text: { errorMessage: string; errorStack?: string }) => ({
      id,
      kind: "scheduled" as const,
      handler: "RemindCustomer",
      eventId: "e-0",
      eventType: "RemindCustomer",
      aggregateType: "customer",
      aggregateId: "ana",
      person: "ana",
      persons: [{ person: "ana", fingerprint: null }],
      payload: { customerId: "ana", email: "ana@new.example", note: "n" },
      errorType: "terminal" as const,
      errorName: "Error",
      attempts: 1,
      firstFailedAt: "2026-01-01T00:00:00.000Z",
      lastFailedAt: "2026-01-01T00:00:00.000Z",
      ...text,
    });
    await storage.deadLetterStore.add(letter("l-1", { errorMessage: "refused ana@old.example" }));
    await storage.deadLetterStore.add(
      letter("l-2", { errorMessage: "refused", errorStack: "at ana@old.example" }),
    );
    await storage.deadLetterStore.add(
      letter("l-3", { errorMessage: "refused", errorStack: "at nowhere" }),
    );
    await app.redact("ana", { events: [target(registered, ["email"])] });
    const [first, second, third] = await Promise.all(
      ["l-1", "l-2", "l-3"].map((id) => storage.deadLetterStore.get(id)),
    );
    expect(isSealed(first?.errorMessage)).toBe(true);
    expect(first?.errorStack).toBeUndefined();
    expect(first).toMatchObject({
      payload: letter("l-1", { errorMessage: "" }).payload,
      persons: letter("l-1", { errorMessage: "" }).persons,
    });
    expect(isSealed(second?.errorMessage)).toBe(true);
    expect(isSealed(second?.errorStack)).toBe(true);
    expect(third).toMatchObject({ errorMessage: "refused", errorStack: "at nowhere" });
  });

  it("settles what work running at the redaction wrote after it, across pages, and nothing it wrote anew", async () => {
    const { app, commands, register, target, redactions, ledgerRedactions, logged, appendsOf } =
      await setUp(2);
    const registered = await register("ana", "ana@old.example");
    await app.redact("ana", { events: [target(registered, ["email"])] });
    // As commands decided on what was read before the redaction committed would.
    await commands.correctEmail?.({ customerId: "ana", email: "ana@other.example" });
    await commands.correctEmail?.({ customerId: "ana", email: "ana@old.example" });
    // One whose personal field the payload leaves out, and another late one on the next page.
    await commands.registerCustomer?.({ customerId: "ana", email: "ana@new.example", plan: "pro" });
    await commands.correctEmail?.({ customerId: "ana", email: "ana@old.example" });
    // An event of the person that marks nothing, after the redaction.
    await app.forget("ana", { categories: ["profile"] });
    await app.runUntilIdle();
    const [, followUp] = await redactions();
    expect(appendsOf(followUp?.id)).toHaveLength(2);
    const reached =
      (followUp?.payload as { events: readonly RedactedFields[] } | undefined)?.events ?? [];
    expect(reached.map(({ type, fields }) => [type, fields])).toEqual([
      ["EmailCorrected", ["email"]],
      ["EmailCorrected", ["email"]],
    ]);
    expect(ledgerRedactions()).toHaveLength(2);
    const exported = await app.exportPersonalData("ana");
    expect(
      exported.events.filter(({ type }) => type === "EmailCorrected").map(({ data }) => data),
    ).toEqual([{ email: "ana@other.example" }, { email: null }, { email: null }]);
    expect(logged.filter(({ level }) => level === "warn")).toEqual([]);
  });

  it("cancels, and logs by id, a command holding an old value that work running at the redaction scheduled after it", async () => {
    const { app, storage, commands, register, target, logged, redactions } = await setUp();
    const registered = await register("ana", "ana@old.example");
    await app.redact("ana", { events: [target(registered, ["email"])] });
    await commands.remindCustomer?.(
      { customerId: "ana", email: "ana@old.example", note: "n" },
      { delay: "1d" },
    );
    const late = (await storage.scheduler.list()).find(({ dedupeKey }) =>
      dedupeKey.startsWith("command:"),
    );
    await storage.deadLetterStore.add({
      id: "late-letter",
      kind: "scheduled",
      handler: "RemindCustomer",
      eventId: "e-0",
      eventType: "RemindCustomer",
      aggregateType: "customer",
      aggregateId: "ana",
      person: "ana",
      persons: [{ person: "ana", fingerprint: null }],
      payload: { customerId: "ana", email: "ana@old.example", note: "n" },
      errorType: "terminal",
      errorName: "Error",
      errorMessage: "refused",
      attempts: 1,
      firstFailedAt: "2026-01-01T00:00:00.000Z",
      lastFailedAt: "2026-01-01T00:00:00.000Z",
    });
    await app.runUntilIdle();
    expect(await redactions()).toHaveLength(1);
    expect(
      (await storage.scheduler.list()).filter(
        ({ command }) => command.type !== "bounda.ProcessDeadline",
      ),
    ).toEqual([]);
    expect(logged.filter(({ level }) => level === "warn")).toEqual([
      {
        level: "warn",
        message: "work running at a redaction stored an old value; it is gone",
        fields: {
          personId: "ana",
          cancelledCommands: [scheduledCommandId(late?.dedupeKey ?? "")],
          removedDeadLetters: ["late-letter"],
        },
      },
    ]);
  });

  it("settles what a process step wrote of an old value after the redaction", async () => {
    const { app, commands, register, target, redactions } = await setUp();
    const registered = await register("ana", "ana@old.example");
    await app.runUntilIdle();
    await app.redact("ana", { events: [target(registered, ["email"])] });
    await commands.correctEmail?.({ customerId: "ana", email: "ana@old.example" });
    await app.runUntilIdle();
    const [, followUp] = await redactions();
    const reached =
      (followUp?.payload as { events: readonly RedactedFields[] } | undefined)?.events ?? [];
    expect(reached.map(({ type, fields }) => [type, fields])).toEqual([
      ["EmailCorrected", ["email"]],
      ["ProcessHandled", ["contact"]],
    ]);
    await expectRedacted(app, "ana");
  });

  it("compares nothing it can no longer open when it settles", async () => {
    const { app, commands, register, target, redactions } = await setUp();
    const registered = await register("ana", "ana@old.example");
    await app.redact("ana", { events: [target(registered, ["email"])] });
    // The aggregate reads the redacted email as null, sealed under the profile key.
    await commands.echoEmail?.({ customerId: "ana" });
    await app.forget("ana", { categories: ["default"] });
    await app.runUntilIdle();
    expect(await redactions()).toHaveLength(1);
  });

  it("skips, on a restore, a redaction whose events the copy does not hold", async () => {
    const { app, clock, register, target, entries, redactions, appendsOf } = await setUp();
    const registered = await register("ana", "ana@old.example");
    const at = new Date(clock.now().getTime() - 120_000).toISOString();
    entries.set("lost", {
      personId: "ana",
      categories: null,
      eventId: "lost",
      forgottenAt: at,
      reason: "requested",
      redaction: { events: [{ ...target(registered, ["email"]), id: "not-in-the-copy" }] },
    });
    await app.restored();
    await app.runUntilIdle();
    expect(await redactions()).toEqual([]);
    expect((await app.getLag()).forgetLedger).toEqual({ reconciled: true });
    expect(appendsOf("lost")).toEqual([]);
  });

  it("redacts again only what an entry names that its event marks personal", async () => {
    const { app, clock, register, target, entries, redactions, events } = await setUp();
    const registered = await register("ana", "ana@old.example");
    const first = await app.redact("ana", { events: [target(registered, ["note"])] });
    expect(first.eventIds).toEqual([]);
    const own = await app.redact("ana", { events: [target(registered, ["email"])] });
    const [redaction] = await redactions();
    if (redaction === undefined) throw new Error("not redacted");
    const at = new Date(clock.now().getTime() - 120_000).toISOString();
    entries.set("odd", {
      personId: "ana",
      categories: null,
      eventId: "odd",
      forgottenAt: at,
      reason: "requested",
      redaction: {
        events: [target(registered, ["plan"]), { ...target(redaction, ["personId"]) }],
      },
    });
    await app.restored();
    await app.runUntilIdle();
    expect((await redactions()).map(({ id }) => id)).toEqual(own.eventIds);
    expect((await app.getLag()).forgetLedger).toEqual({ reconciled: true });
    expect((await events()).find(({ id }) => id === registered.id)?.payload).toMatchObject({
      plan: "pro",
    });
  });

  it("commits again a redaction the ledger holds and the store does not, and counts it as a restore", async () => {
    const { app, clock, register, target, entries, redactions, logged } = await setUp();
    const registered = await register("ana", "ana@old.example");
    await app.runUntilIdle();
    entries.set("re-1", {
      personId: "ana",
      categories: null,
      eventId: "re-1",
      forgottenAt: new Date(clock.now().getTime() - 120_000).toISOString(),
      reason: "requested",
      redaction: { events: [target(registered, ["email"])] },
    });
    clock.advance(10 * 60_000);
    await app.runUntilIdle();
    expect((await redactions()).map(({ id }) => id)).toEqual(["re-1"]);
    expect(logged.filter(({ message }) => message.startsWith("redaction committed"))).toEqual([
      {
        level: "info",
        message: "redaction committed again from the forget ledger",
        fields: { personId: "ana", eventId: "re-1" },
      },
    ]);
    expect((await app.status()).restoresFound).toBe(1);
  });

  it("tries a redaction it could not settle again, a poll later", async () => {
    const base = memory();
    let failing = true;
    const adapter: Adapter = {
      ...base,
      createStorage: async () => {
        const storage = await base.createStorage();
        return {
          ...storage,
          subscriberFailures: {
            ...storage.subscriberFailures,
            list: async () => {
              if (failing) {
                failing = false;
                throw new Error("failures are down");
              }
              return storage.subscriberFailures.list();
            },
          },
        };
      },
    };
    const { app, clock, register, target, logged, scrubs } = await setUp(undefined, adapter);
    const registered = await register("ana", "ana@old.example");
    await app.redact("ana", { events: [target(registered, ["email"])] });
    await app.runUntilIdle();
    expect(logged.filter(({ level }) => level === "error")).toEqual([
      expect.objectContaining({
        message: "a redaction could not be settled; the worker tries again",
        fields: expect.objectContaining({
          dedupeKey: expect.stringMatching(/^redaction:/),
          errorName: "Error",
        }),
      }),
    ]);
    expect(await scrubs()).toHaveLength(1);
    clock.advance(60_000);
    await app.runUntilIdle();
    expect(await scrubs()).toEqual([]);
  });

  it("lists no redaction for an event of the app's own that bears the runtime's name", async () => {
    const { app, commands, register } = await setUp();
    await register("ana", "ana@old.example");
    await commands.logRedaction?.({ customerId: "ana" });
    const exported = await app.exportPersonalData("ana");
    expect(exported.redactions).toEqual([]);
    expect(exported.events.map(({ type }) => type)).toContain("PersonalDataRedacted");
  });

  it("says redacted only of the fields its event still marks", async () => {
    const adapter = memory();
    const before = await createTestApp({ registry, adapter });
    await (
      before.app.commands as unknown as Record<string, (payload: unknown) => Promise<unknown>>
    ).registerCustomer?.({ customerId: "ana", email: "ana@old.example", note: "n", plan: "pro" });
    const [registered] = (await before.app.exportPersonalData("ana")).events;
    if (registered === undefined) throw new Error("not registered");
    await before.app.redact("ana", {
      events: [{ ...registered, fields: ["email", "note"] }] as never,
    });
    await before.app.stop();
    const customer = (registry.aggregates as unknown as Record<string, Record<string, unknown>>)
      .customer;
    const events = customer?.events as Record<string, object>;
    const unmarked = {
      ...registry,
      aggregates: {
        customer: {
          ...customer,
          events: {
            ...events,
            customerRegistered: {
              ...events.customerRegistered,
              payload: ({ z, personal }: EventPayloadArgs) =>
                z.object({
                  email: personal(z.string()),
                  note: z.string().optional(),
                  plan: z.string(),
                }),
            },
          },
        },
      },
    } as unknown as Registry;
    const after = await createTestApp({ registry: unmarked, adapter });
    stops.push(() => after.app.stop());
    expect((await after.app.exportPersonalData("ana")).events[0]).toMatchObject({
      data: { email: null },
      redacted: ["email"],
    });
  });
});
