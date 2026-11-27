import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import type {
  ForgetLedger,
  ForgetLedgerEntry,
  LedgerDisclosure,
} from "../../adapter/storage/forget-ledger.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ValidationError } from "../../contracts/errors.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { type Logger, silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { PROCESSING_RESTRICTED_EVENT } from "../../modules/bounda-events.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { createApp } from "../app.ts";
import { disclosureOfLedger } from "../recipients/transfer.ts";
import { defineForgetLedger, type ForgetLedgerSource } from "./forget-ledger.ts";
import { FORGET_LEDGER_GRACE_MS } from "./reconciliation.ts";
import { DEFAULT_TENANT } from "./tenant-keys.ts";

const START = new Date("2026-03-01T00:00:00.000Z");
const DAY = 24 * 60 * 60_000;

const registry = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ name: personal(z.string()) }),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({ customerId: notPersonal(z.string()), name: notPersonal(z.string()) }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { name: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerRegistered?.({ name: command.payload.name })],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as unknown as Registry;

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

let starts = 0;

const start = async (
  storage: Adapter,
  ledger: ForgetLedgerSource | null,
  logger: Logger = silentLogger,
) => {
  starts += 1;
  const app = await createApp({
    registry,
    config: {
      storage,
      runtime: {
        personalData: ledger === null ? {} : { forgetLedger: { store: ledger } },
      },
    },
    ids: createSequentialIdGenerator({ prefix: `app-${starts}` }),
    clock: createFixedClock(START),
    logger,
  });
  stops.push(() => app.stop());
  const register = async (...customerIds: readonly string[]): Promise<void> => {
    const commands = app.commands as unknown as Record<
      string,
      (payload: { customerId: string; name: string }) => Promise<unknown>
    >;
    for (const customerId of customerIds) {
      await commands.registerCustomer?.({ customerId, name: `name of ${customerId}` });
    }
    await app.runUntilIdle();
  };
  const eventOf = async (id: string) =>
    (await app.events.read({ limit: 1000 })).find((event) => event.id === id);
  return { app, register, eventOf };
};

// Old enough for a reconciliation to commit it again, and far before what it reads again.
const LOST = new Date(START.getTime() - DAY);

const forgetting = (personId: string, eventId: string, at = LOST): ForgetLedgerEntry => ({
  personId,
  categories: null,
  eventId,
  forgottenAt: at.toISOString(),
  reason: "requested",
});

const restricting = (personId: string, eventId: string, at = LOST): ForgetLedgerEntry => ({
  ...forgetting(personId, eventId, at),
  restriction: {
    type: PROCESSING_RESTRICTED_EVENT,
    payload: {
      personId,
      ground: "accuracy-contested",
      categories: null,
      restrictions: [{ ground: "accuracy-contested", categories: null, since: at.toISOString() }],
    },
  },
});

// Its transfer as it was kept, not as the lists would derive it now: applied again, it stays so.
const DISCLOSURE: LedgerDisclosure = {
  port: "customer.mailer",
  recipient: "Acme Mail",
  kind: "processor",
  country: "DE",
  transfer: {
    safeguard: "standard-contractual-clauses",
    article: "46(2)(c)",
    regime: "CH",
    partialAdequacy: null,
  },
  category: "default",
};

const disclosing = (personId: string, at = LOST): ForgetLedgerEntry => ({
  ...forgetting(personId, `disclosure-${personId}`, at),
  disclosure: DISCLOSURE,
  committed: false,
});

const ledgerOf = (adapter: Adapter): Promise<ForgetLedger> =>
  adapter.createForgetLedger({ tenant: DEFAULT_TENANT });

const disclosuresOf = async (storage: Adapter, personId: string) => {
  const opened = await storage.createStorage();
  try {
    return await opened.recipients.disclosures(personId);
  } finally {
    await opened.close();
  }
};

describe("applying a forget ledger's entries again by hand", () => {
  it("applies each kind as the reconciliation does, under its own id and time, records it in the ledger first, and names who did it", async () => {
    const storage = memory();
    const ledger = memory();
    const { app, register, eventOf } = await start(storage, ledger);
    await register("c-1", "c-2", "c-3");
    const registered = (await app.events.read({ limit: 100 })).find(
      (event) => event.aggregateId === "c-3",
    );
    if (registered === undefined) throw new Error("c-3 is registered");
    const redacting: ForgetLedgerEntry = {
      ...forgetting("c-3", "e-redact"),
      redaction: {
        events: [
          {
            id: registered.id,
            aggregateType: "customer",
            aggregateId: "c-3",
            type: "CustomerRegistered",
            fields: ["name"],
          },
        ],
      },
    };
    const entries: readonly ForgetLedgerEntry[] = [
      forgetting("c-1", "e-forget"),
      // Written as an intention where another database stood.
      {
        ...restricting("c-2", "e-restrict"),
        committed: false,
        reached: { position: 99, generation: 9 },
      },
      redacting,
      disclosing("c-2"),
    ];

    expect(await app.applyAgain(entries, { actor: "ops-ana" })).toEqual([
      { personId: "c-1", eventId: "e-forget", kind: "forgetting", outcome: "applied" },
      { personId: "c-2", eventId: "e-restrict", kind: "restriction", outcome: "applied" },
      { personId: "c-3", eventId: "e-redact", kind: "redaction", outcome: "applied" },
      { personId: "c-2", eventId: "disclosure-c-2", kind: "disclosure", outcome: "applied" },
    ]);
    for (const [id, type] of [
      ["e-forget", "PersonalDataForgotten"],
      ["e-restrict", "ProcessingRestricted"],
      ["e-redact", "PersonalDataRedacted"],
    ] as const) {
      expect(await eventOf(id)).toMatchObject({
        type,
        timestamp: LOST.toISOString(),
        metadata: { actor: "ops-ana" },
      });
    }
    expect((await app.exportPersonalData("c-3")).events[0]?.data).toEqual({ name: null });
    expect(await disclosuresOf(storage, "c-2")).toEqual([
      expect.objectContaining({
        ...disclosureOfLedger("c-2", DISCLOSURE),
        firstAt: LOST.toISOString(),
      }),
    ]);
    // Each recorded in the ledger the configuration names, under its own id and time.
    expect(
      (await (await ledgerOf(ledger)).read({ limit: 10 })).map(({ eventId, forgottenAt }) => ({
        eventId,
        forgottenAt,
      })),
    ).toEqual(
      expect.arrayContaining(
        ["e-forget", "e-restrict", "e-redact"].map((eventId) => ({
          eventId,
          forgottenAt: LOST.toISOString(),
        })),
      ),
    );

    const recorded = (await (await ledgerOf(ledger)).read({ limit: 10 })).find(
      ({ eventId }) => eventId === "e-restrict",
    );
    expect(recorded?.reached).not.toEqual({ position: 99, generation: 9 });

    // The disclosure is recorded there too, under the id what tells it apart gives it.
    expect(
      (await (await ledgerOf(ledger)).read({ limit: 10 })).filter(
        ({ personId, disclosure }) => personId === "c-2" && disclosure !== undefined,
      ),
    ).toEqual([
      expect.objectContaining({ disclosure: DISCLOSURE, forgottenAt: LOST.toISOString() }),
    ]);

    // Run again, it applies nothing more.
    expect(await app.applyAgain(entries)).toEqual([
      { personId: "c-1", eventId: "e-forget", kind: "forgetting", outcome: "held" },
      { personId: "c-2", eventId: "e-restrict", kind: "restriction", outcome: "held" },
      { personId: "c-3", eventId: "e-redact", kind: "redaction", outcome: "held" },
      { personId: "c-2", eventId: "disclosure-c-2", kind: "disclosure", outcome: "held" },
    ]);
  });

  it("records each in the ledger before it applies it, as a ledger that refuses every committed copy shows", async () => {
    const storage = memory();
    const kept = memory();
    // Takes intentions alone, as a ledger that went down between an intention and its commit.
    const intentionsOnly = defineForgetLedger(async ({ tenant }) => {
      const ledger = await kept.createForgetLedger({ tenant });
      return {
        ...ledger,
        append: async (entries) => {
          if (entries.some(({ committed }) => committed !== false)) {
            throw new Error("the ledger takes no committed copy now");
          }
          await ledger.append(entries);
        },
      };
    });
    const { app, register } = await start(storage, intentionsOnly);
    await register("c-1", "c-2");
    const entries = [forgetting("c-1", "e-forget"), restricting("c-2", "e-restrict")];
    expect((await app.applyAgain(entries)).map(({ outcome }) => outcome)).toEqual([
      "applied",
      "applied",
    ]);
    await app.runUntilIdle();
    expect(
      (await (await ledgerOf(kept)).read({ limit: 10 })).map(({ eventId, committed }) => ({
        eventId,
        committed,
      })),
    ).toEqual(
      expect.arrayContaining([
        { eventId: "e-forget", committed: false },
        { eventId: "e-restrict", committed: false },
      ]),
    );
  });

  it("applies them without a forget ledger too", async () => {
    const { app, register, eventOf } = await start(memory(), null);
    await register("c-1");
    expect(await app.applyAgain([forgetting("c-1", "e-forget")])).toEqual([
      { personId: "c-1", eventId: "e-forget", kind: "forgetting", outcome: "applied" },
    ]);
    expect(await eventOf("e-forget")).toMatchObject({ timestamp: LOST.toISOString() });
  });

  it("leaves to the reconciliation an entry the ledger holds where it reads it, and applies one it holds from before", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const ledger = await ledgerOf(ledgerAdapter);
    // Read by the reconciliation at start, which moves the cursor to it.
    const read = new Date(START.getTime() - FORGET_LEDGER_GRACE_MS - 60_000);
    await ledger.append([forgetting("c-0", "e-read", read)]);
    const { app, register } = await start(storage, ledgerAdapter);
    await register("c-1", "c-2");
    const recent = forgetting("c-1", "e-recent", read);
    const before = forgetting("c-2", "e-before");
    await ledger.append([recent, before]);
    expect((await app.applyAgain([recent, before])).map(({ outcome }) => outcome)).toEqual([
      "reconciled",
      "applied",
    ]);
  });

  it("refuses what nothing applies to the database as it stands, as the reconciliation decides", async () => {
    const ledger = memory();
    const { app, register } = await start(memory(), ledger);
    await register("c-1", "c-2", "c-3");
    await app.restrict("c-2", { ground: "legal-claims" });
    await app.forget("c-3");
    await app.runUntilIdle();
    const registered = (await app.events.read({ limit: 100 })).find(
      (event) => event.aggregateId === "c-3" && event.type === "CustomerRegistered",
    );
    if (registered === undefined) throw new Error("c-3 is registered");
    const entries: readonly ForgetLedgerEntry[] = [
      // Nobody of that id holds a key.
      forgetting("c-9", "e-nobody"),
      // A later change of c-2's restrictions is held.
      restricting("c-2", "e-earlier"),
      // c-3's name opens for nobody any more.
      {
        ...forgetting("c-3", "e-redact"),
        redaction: {
          events: [
            {
              id: registered.id,
              aggregateType: "customer",
              aggregateId: "c-3",
              type: "CustomerRegistered",
              fields: ["name"],
            },
          ],
        },
      },
      // c-3 was forgotten since.
      disclosing("c-3"),
    ];
    expect(await app.applyAgain(entries)).toEqual(
      entries.map(({ personId, eventId }, index) => ({
        personId,
        eventId,
        kind: (["forgetting", "restriction", "redaction", "disclosure"] as const)[index],
        outcome: "inapplicable",
      })),
    );
    // Nothing that does not apply is recorded in the ledger.
    const recorded = (await (await ledgerOf(ledger)).read({ limit: 100 })).map(
      ({ eventId, personId, disclosure }) => (disclosure === undefined ? eventId : personId),
    );
    expect(recorded).not.toContain("e-nobody");
    expect(recorded).not.toContain("e-earlier");
    expect(recorded).not.toContain("e-redact");
    expect(recorded.filter((each) => each === "c-3")).toEqual([]);
  });

  it("rejects an entry without a person's id, or an actor as refuses, before applying any", async () => {
    const { app, register, eventOf } = await start(memory(), memory());
    await register("c-1");
    const first = forgetting("c-1", "e-forget");
    await expect(app.applyAgain([first, forgetting("", "e-none")])).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(app.applyAgain([first], { actor: "" })).rejects.toBeInstanceOf(ValidationError);
    expect(await eventOf("e-forget")).toBeUndefined();
  });
});
