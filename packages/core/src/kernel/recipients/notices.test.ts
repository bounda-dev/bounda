import { beforeEach, describe, expect, it } from "vitest";
import { testMetadata } from "../../adapter/testing/fixtures.ts";
import { resolveConfig } from "../../config/schema.ts";
import { createFixedClock, type FixedClock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import type { PersonalDataAccess } from "../../modules/audit.ts";
import type { NotifiedRecipient } from "../../modules/recipient.ts";
import type { AppStorage } from "../events/app-event-store.ts";
import type { RecordAccess } from "../personal-data/access.ts";
import { deriveDeadLetterId, deriveIdempotencyKey } from "../shared/idempotency-key.ts";
import { ignoredRetries } from "../shared/pending-retries.ts";
import { installFakeTelemetry } from "../telemetry-fake.ts";
import { createRecordingLogger, withPersonalKeys } from "../test-support.ts";
import type { RecipientRuntime, RecipientsRuntime } from "./build.ts";
import {
  createRecipientCatchUp,
  createRecipientDelivery,
  createRecipientNotices,
  createRecipientSubscriber,
  noticesOf,
  presumedNotice,
  type RecipientDelivery,
} from "./notices.ts";

interface Told {
  readonly port: string;
  readonly args: Readonly<Record<string, unknown>>;
}

let told: Told[];
let failing: Set<string>;

const recipient = (
  port: string,
  categories: readonly string[],
  formerly: readonly string[] = [],
) => {
  const [owner = "", name = ""] = port.split(".");
  const handler = (args: Readonly<Record<string, unknown>>) => {
    if (failing.has(port)) throw new Error(`${port} is down`);
    told.push({ port, args });
  };
  return {
    port,
    owner,
    name,
    recipient: "Mailchimp",
    kind: "processor",
    country: "US",
    safeguard: "standard-contractual-clauses",
    categories,
    formerly,
    handlers: {
      onPersonalDataForgotten: handler,
      onProcessingRestricted: handler,
      onProcessingRestrictionLiftAnnounced: handler,
      onProcessingRestrictionLifted: handler,
      onPersonalDataRedacted: handler,
    },
    implementation: () => `${name} port`,
  } as unknown as RecipientRuntime;
};

const MAILER = recipient("customer.mailer", ["contact", "profile"], ["customer.newsletter"]);
const CRM = recipient("customer.crm", ["invoices"]);

const runtime: RecipientsRuntime = {
  all: [MAILER, CRM],
  byPort: { "customer.mailer": MAILER, "customer.newsletter": MAILER, "customer.crm": CRM },
  byOwner: { customer: { mailer: MAILER, crm: CRM } },
};

const notice = (port: string, overrides: Partial<NotifiedRecipient> = {}): NotifiedRecipient => ({
  port,
  categories: ["contact"],
  retained: [],
  presumed: false,
  ...overrides,
});

let storage: AppStorage;
let clock: FixedClock;
let accesses: PersonalDataAccess[];

const recordAccess: RecordAccess = async (args) => {
  accesses.push({ ...args, persons: [...args.persons] } as unknown as PersonalDataAccess);
};

const config = resolveConfig({
  storage: memory(),
  runtime: { policies: { retry: { strategy: "none" } } },
});

// Appends one event of the runtime's to the person's stream, and answers it as stored.
const append = async (
  type: string,
  payload: Readonly<Record<string, unknown>>,
  person = "c-1",
  aggregateType = "bounda",
): Promise<StoredEvent> =>
  storage.transact(async (transaction) => {
    const { version } = await transaction.eventStore.load({ aggregateType, aggregateId: person });
    const { events } = await transaction.eventStore.append({
      aggregateType,
      aggregateId: person,
      expectedVersion: version,
      events: [
        {
          id: `${type}-${person}-${version + 1}`,
          aggregateType,
          aggregateId: person,
          version: version + 1,
          type,
          payload: { personId: person, ...payload },
          timestamp: clock.now().toISOString(),
          metadata: testMetadata,
          person,
        },
      ],
    });
    return events[0] as StoredEvent;
  });

const notices = () =>
  createRecipientNotices({ recipients: runtime, storage, config, clock, recordAccess });

const unit = () => ({}) as never;

const span = {} as never;

beforeEach(async () => {
  told = [];
  failing = new Set();
  accesses = [];
  clock = createFixedClock(new Date("2026-03-01T00:00:00.000Z"));
  storage = withPersonalKeys(await memory().createStorage(), clock);
});

describe("noticesOf", () => {
  it("reads whom an event of the runtime's tells, and nobody for any other event", async () => {
    const recipients = [notice("customer.mailer")];
    expect(noticesOf(await append("ProcessingRestricted", { recipients }))).toEqual(recipients);
    expect(noticesOf(await append("ProcessingRestricted", {}))).toEqual([]);
    expect(noticesOf(await append("Note", { recipients }))).toEqual([]);
    expect(
      noticesOf(await append("ProcessingRestricted", { recipients }, "c-1", "customer")),
    ).toEqual([]);
  });
});

describe("presumedNotice", () => {
  it("tells a recipient declared late of what the event touches that it declares, kept categories alone included", async () => {
    expect(
      presumedNotice(
        MAILER,
        await append("PersonalDataForgotten", {
          categories: ["profile", "invoices"],
          expired: ["contact"],
          retained: [],
        }),
      ),
    ).toEqual({
      port: "customer.mailer",
      categories: ["contact", "profile"],
      retained: [],
      presumed: true,
    });
    expect(
      presumedNotice(
        CRM,
        await append("PersonalDataForgotten", {
          categories: [],
          expired: [],
          retained: ["invoices"],
        }),
      ),
    ).toEqual({ port: "customer.crm", categories: [], retained: ["invoices"], presumed: true });
    expect(
      presumedNotice(CRM, await append("ProcessingRestricted", { categories: ["contact"] })),
    ).toBeUndefined();
    expect(presumedNotice(CRM, await append("Note", { categories: null }))).toBeUndefined();
  });
});

describe("createRecipientNotices", () => {
  it("hands the handler the event, what concerns its recipient, a key of its own and the port, and records it", async () => {
    const event = await append("PersonalDataForgotten", {
      whole: true,
      recipients: [notice("customer.mailer", { retained: ["invoices"], presumed: true })],
    });
    await notices().run({
      port: "customer.mailer",
      event,
      attempt: 1,
      actor: "ops-1",
      within: unit(),
    });
    expect(told).toEqual([
      {
        port: "customer.mailer",
        args: {
          event,
          categories: ["contact"],
          retained: ["invoices"],
          presumed: true,
          idempotencyKey: deriveIdempotencyKey({
            kind: "recipient",
            handler: "customer.mailer",
            subject: event.id,
            retryId: undefined,
          }),
          signal: expect.any(AbortSignal),
          mailer: "mailer port",
        },
      },
    ]);
    expect(accesses).toEqual([
      {
        operation: "recipientNotice",
        detail: {
          recipient: "customer.mailer",
          event: "PersonalDataForgotten",
          eventId: event.id,
          categories: ["contact", "invoices"],
          superseded: false,
        },
        actor: "ops-1",
        persons: ["c-1"],
        outcome: "ok",
      },
    ]);
  });

  it("gives a retry another key, and an event other than a forgetting no retained categories", async () => {
    const event = await append("ProcessingRestricted", {
      recipients: [notice("customer.mailer")],
    });
    await notices().run({
      port: "customer.mailer",
      event,
      attempt: 2,
      retryId: "r-1",
      within: unit(),
    });
    expect(told[0]?.args).not.toHaveProperty("retained");
    expect(told[0]?.args.idempotencyKey).toBe(
      deriveIdempotencyKey({
        kind: "recipient",
        handler: "customer.mailer",
        subject: event.id,
        retryId: "r-1",
      }),
    );
    expect(accesses[0]?.actor).toBe("user-1");
  });

  it("tells what it is given, else what the event names, else what a recipient declared late is presumed to hold", async () => {
    const event = await append("PersonalDataRedacted", {
      categories: ["profile"],
      recipients: [notice("customer.newsletter", { categories: ["contact"] })],
    });
    await notices().run({
      port: "customer.mailer",
      event,
      attempt: 1,
      told: notice("customer.mailer", { categories: ["profile"], presumed: true }),
      within: unit(),
    });
    await notices().run({ port: "customer.newsletter", event, attempt: 1, within: unit() });
    await notices().run({ port: "customer.mailer", event, attempt: 1, within: unit() });
    await notices().run({ port: "customer.crm", event, attempt: 1, within: unit() });
    expect(told.map(({ args }) => [args.categories, args.presumed])).toEqual([
      [["profile"], true],
      [["contact"], false],
      [["profile"], true],
    ]);
  });

  it("does nothing for an event no recipient is told of, and refuses a port the app no longer declares", async () => {
    const note = await append("Note", { recipients: [notice("customer.mailer")] });
    await notices().run({ port: "customer.mailer", event: note, attempt: 1, within: unit() });
    expect(told).toEqual([]);
    const event = await append("ProcessingRestricted", { recipients: [notice("order.sms")] });
    await expect(
      notices().run({ port: "order.sms", event, attempt: 1, within: unit() }),
    ).rejects.toEqual(
      new ConfigurationError(
        `Port order.sms is not declared any more, so its recipient cannot be told of ProcessingRestricted ${event.id}: declare it again, or name it in recipient.formerly of the port that took over, and retry this letter, or tell the recipient by hand and discard it`,
      ),
    );
    const presumed = await append("ProcessingRestricted", {});
    await expect(
      notices().run({ port: "order.sms", event: presumed, attempt: 1, within: unit() }),
    ).resolves.toBeUndefined();
  });

  it("records a notice whose handler failed as failed, and throws its error", async () => {
    failing.add("customer.mailer");
    const event = await append("ProcessingRestricted", { recipients: [notice("customer.mailer")] });
    await expect(
      notices().run({ port: "customer.mailer", event, attempt: 1, within: unit() }),
    ).rejects.toThrow("customer.mailer is down");
    expect(accesses.map(({ outcome }) => outcome)).toEqual(["failed"]);
  });

  it("skips a notice a later forgetting of the person as a whole told the recipient, under any of its keys", async () => {
    const recipients = [notice("customer.mailer")];
    const forgottenFirst = await append("PersonalDataForgotten", { whole: true, recipients });
    const restricted = await append("ProcessingRestricted", { recipients });
    const lifted = await append("ProcessingRestrictionLifted", { recipients });
    await append("PersonalDataForgotten", { whole: false, recipients });
    await append("PersonalDataForgotten", { whole: true, recipients: [notice("customer.crm")] });
    await append("ProcessingRestricted", { recipients: [notice("customer.newsletter")] });
    await notices().run({ port: "customer.mailer", event: restricted, attempt: 1, within: unit() });
    expect(told).toHaveLength(1);
    await append("PersonalDataForgotten", {
      whole: true,
      recipients: [notice("customer.newsletter")],
    });
    await notices().run({ port: "customer.mailer", event: lifted, attempt: 1, within: unit() });
    await notices().run({
      port: "customer.mailer",
      event: forgottenFirst,
      attempt: 1,
      within: unit(),
    });
    expect(told.map(({ args }) => (args.event as StoredEvent).type)).toEqual([
      "ProcessingRestricted",
      "PersonalDataForgotten",
    ]);
    expect(accesses.map(({ detail }) => (detail as { superseded: boolean }).superseded)).toEqual([
      false,
      true,
      false,
    ]);
  });
});

describe("createRecipientNotices, superseded", () => {
  it("is superseded by a later forgetting as a whole that told it among others, and by no other event", async () => {
    const recipients = [notice("customer.mailer")];
    const restricted = await append("ProcessingRestricted", { recipients });
    await append("ProcessingRestricted", { whole: true, recipients });
    await notices().run({ port: "customer.mailer", event: restricted, attempt: 1, within: unit() });
    expect(told).toHaveLength(1);
    await append("PersonalDataForgotten", {
      whole: true,
      recipients: [notice("customer.crm"), notice("customer.mailer")],
    });
    await notices().run({ port: "customer.mailer", event: restricted, attempt: 1, within: unit() });
    expect(told).toHaveLength(1);
    expect(accesses.at(-1)).toMatchObject({ outcome: "ok", detail: { superseded: true } });
  });

  it("runs the handler within its time, in a span named after the port", async () => {
    const telemetry = installFakeTelemetry();
    try {
      const event = await append("ProcessingRestricted", {
        recipients: [notice("customer.mailer")],
      });
      await notices().run({
        port: "customer.mailer",
        event,
        attempt: 3,
        actor: "ops-1",
        within: unit(),
      });
      expect(telemetry.spans).toContainEqual(
        expect.objectContaining({
          name: "bounda.recipient customer.mailer",
          attributes: expect.objectContaining({
            "bounda.recipient": "customer.mailer",
            "bounda.event.id": event.id,
            "bounda.event.type": "ProcessingRestricted",
            "bounda.correlation_id": testMetadata.correlationId,
            "bounda.attempt": 3,
            "bounda.actor": "ops-1",
          }),
        }),
      );
    } finally {
      telemetry.restore();
    }
    const slow = {
      ...runtime,
      byPort: {
        ...runtime.byPort,
        "customer.mailer": {
          ...MAILER,
          handlers: { ...MAILER.handlers, onProcessingRestricted: () => new Promise(() => {}) },
        } as unknown as RecipientRuntime,
      },
    };
    const event = await append("ProcessingRestricted", { recipients: [notice("customer.mailer")] });
    const running = createRecipientNotices({
      recipients: slow,
      storage,
      config,
      clock,
      recordAccess,
    }).run({ port: "customer.mailer", event, attempt: 1, within: unit() });
    await new Promise((resolve) => setTimeout(resolve, 5));
    clock.advance(config.forAggregate("customer").policies.timeoutMs);
    await expect(running).rejects.toThrow(
      `recipient customer.mailer did not finish within ${config.forAggregate("customer").policies.timeoutMs}ms`,
    );
  });
});

describe("createRecipientDelivery", () => {
  const deliveryOf = (logger = createRecordingLogger().logger) =>
    createRecipientDelivery({
      recipients: runtime,
      notices: notices(),
      storage,
      config,
      clock,
      pendingRetries: ignoredRetries,
      logger,
    });

  it("tells a recipient once, through a claim of its own", async () => {
    const event = await append("ProcessingRestricted", { recipients: [notice("customer.mailer")] });
    const delivery = deliveryOf();
    expect(await delivery.deliver("customer.mailer", event)).toBe("done");
    expect(await delivery.deliver("customer.mailer", event)).toBe("done");
    expect(told).toHaveLength(1);
    expect(
      await storage.inboxLedger.get({ handler: "recipient:customer.mailer", eventId: event.id }),
    ).toMatchObject({
      status: "succeeded",
    });
  });

  it("holds an event another delivery claimed, for as long as twice the handler's time", async () => {
    const slow = {
      ...runtime,
      byPort: {
        ...runtime.byPort,
        "customer.mailer": {
          ...MAILER,
          handlers: { ...MAILER.handlers, onProcessingRestricted: () => new Promise(() => {}) },
        } as unknown as RecipientRuntime,
      },
    };
    const event = await append("ProcessingRestricted", { recipients: [notice("customer.mailer")] });
    const deliveryOn = () =>
      createRecipientDelivery({
        recipients: slow,
        notices: createRecipientNotices({ recipients: slow, storage, config, clock, recordAccess }),
        storage,
        config,
        clock,
        pendingRetries: ignoredRetries,
        logger: createRecordingLogger().logger,
      });
    void deliveryOn().deliver("customer.mailer", event);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { timeoutMs } = config.forAggregate("customer").policies;
    clock.advance(timeoutMs * 2 - 1);
    expect(await deliveryOn().deliver("customer.mailer", event)).toBe("hold");
  });

  it("files a dead letter of a recipient once its attempts run out, and says so", async () => {
    const telemetry = installFakeTelemetry();
    failing.add("customer.mailer");
    const recording = createRecordingLogger("omit");
    const event = await append("ProcessingRestricted", { recipients: [notice("customer.mailer")] });
    expect(await deliveryOf(recording.logger).deliver("customer.mailer", event)).toBe("done");
    const id = deriveDeadLetterId({
      kind: "recipient",
      handler: "customer.mailer",
      subject: event.id,
    });
    expect(await storage.deadLetterStore.get(id)).toMatchObject({
      id,
      kind: "recipient",
      handler: "customer.mailer",
      eventId: event.id,
      eventType: "ProcessingRestricted",
      aggregateType: "bounda",
      aggregateId: "c-1",
      person: "c-1",
      errorType: "retriable_exhausted",
      errorName: "Error",
      attempts: 1,
      firstFailedAt: "2026-03-01T00:00:00.000Z",
      lastFailedAt: "2026-03-01T00:00:00.000Z",
      status: "failed",
    });
    expect(telemetry.counts).toContainEqual({
      metric: "bounda.dead_letters",
      value: 1,
      attributes: {
        "bounda.handler.kind": "recipient",
        "bounda.handler": "customer.mailer",
        "bounda.outcome": "retriable_exhausted",
      },
    });
    telemetry.restore();
    expect(recording.entries).toContainEqual({
      level: "warn",
      message: "recipient notice dead-lettered",
      fields: expect.objectContaining({
        recipient: "customer.mailer",
        eventId: event.id,
        letterId: id,
        errorType: "retriable_exhausted",
        attempts: 1,
      }),
    });
  });

  it("files at once, terminal, what is to be told to a port the app no longer declares, by its owner's settings", async () => {
    const event = await append("ProcessingRestricted", { recipients: [notice("order.sms")] });
    await deliveryOf().deliver("order.sms", event);
    expect(
      await storage.deadLetterStore.get(
        deriveDeadLetterId({ kind: "recipient", handler: "order.sms", subject: event.id }),
      ),
    ).toMatchObject({ errorType: "terminal", errorName: "ConfigurationError" });
  });

  it("retries as the policies of the port's owner are set", async () => {
    failing.add("customer.mailer");
    const event = await append("ProcessingRestricted", { recipients: [notice("customer.mailer")] });
    const owned = createRecipientDelivery({
      recipients: runtime,
      notices: notices(),
      storage,
      config: resolveConfig({
        storage: memory(),
        runtime: { overrides: { customer: { policies: { retry: { strategy: "none" } } } } },
      }),
      clock,
      pendingRetries: ignoredRetries,
      logger: createRecordingLogger().logger,
    });
    expect(await owned.deliver("customer.mailer", event)).toBe("done");
    expect(await storage.deadLetterStore.count({ kind: "recipient" })).toBe(1);
  });

  it("says when a failed notice will be retried", async () => {
    failing.add("customer.mailer");
    const recording = createRecordingLogger("omit");
    const event = await append("ProcessingRestricted", { recipients: [notice("customer.mailer")] });
    const retrying = createRecipientDelivery({
      recipients: runtime,
      notices: notices(),
      storage,
      config: resolveConfig({ storage: memory() }),
      clock,
      pendingRetries: ignoredRetries,
      logger: recording.logger,
    });
    expect(await retrying.deliver("customer.mailer", event)).toBe("hold");
    expect(recording.entries).toContainEqual({
      level: "warn",
      message: "recipient notice failed; will retry",
      fields: expect.objectContaining({
        recipient: "customer.mailer",
        eventId: event.id,
        attempts: 1,
      }),
    });
  });
});

describe("createRecipientSubscriber", () => {
  const recordingDelivery = (holding: ReadonlySet<string> = new Set()) => {
    const delivered: [string, string][] = [];
    const delivery: RecipientDelivery = {
      deliver: async (port, event) => {
        delivered.push([port, event.id]);
        return holding.has(port) ? "hold" : "done";
      },
    };
    return { delivered, delivery };
  };

  it("delivers each event's notices in order, holding a recipient's later ones after one it holds", async () => {
    const one = await append("ProcessingRestricted", {
      recipients: [notice("customer.newsletter"), notice("customer.crm")],
    });
    const other = await append("Note", { recipients: [notice("customer.crm")] });
    const two = await append("ProcessingRestricted", {
      recipients: [notice("customer.mailer"), notice("customer.crm")],
    });
    const { delivered, delivery } = recordingDelivery(new Set(["customer.newsletter"]));
    const subscriber = createRecipientSubscriber({ recipients: runtime, delivery, storage });
    expect(subscriber).toMatchObject({ name: "recipients", kind: "policy" });
    expect(await subscriber.process([one, other, two], span)).toBe(0);
    expect(delivered).toEqual([
      ["customer.newsletter", one.id],
      ["customer.crm", one.id],
      ["customer.crm", two.id],
    ]);
    const all = recordingDelivery();
    expect(
      await createRecipientSubscriber({
        recipients: runtime,
        delivery: all.delivery,
        storage,
      }).process([one, other, two], span),
    ).toBe(3);
  });

  it("holds a recipient still being told what came before it was declared", async () => {
    const one = await append("ProcessingRestricted", {
      recipients: [notice("customer.crm"), notice("customer.mailer")],
    });
    await storage.recipients.declare(
      [{ port: "customer.mailer", categories: ["contact"] }],
      9,
      "t",
    );
    await storage.recipients.declare([{ port: "customer.crm", categories: ["invoices"] }], 2, "t");
    await storage.recipients.caughtUp("customer.crm", 2);
    const { delivered, delivery } = recordingDelivery();
    expect(
      await createRecipientSubscriber({ recipients: runtime, delivery, storage }).process(
        [one],
        span,
      ),
    ).toBe(0);
    expect(delivered).toEqual([["customer.crm", one.id]]);
  });
});

describe("createRecipientCatchUp", () => {
  const catchUpOf = (delivery: RecipientDelivery, batchSize = 2) =>
    createRecipientCatchUp({ recipients: runtime, delivery, storage, batchSize });

  const recorded = (holdOn?: string) => {
    const delivered: [string, string, boolean][] = [];
    const delivery: RecipientDelivery = {
      deliver: async (port, event, told) => {
        delivered.push([port, event.type, told?.presumed ?? false]);
        return event.id === holdOn ? "hold" : "done";
      },
    };
    return { delivered, delivery };
  };

  const caughtUp = async (port: string) =>
    (await storage.recipients.declared()).find((row) => row.port === port)?.caughtUpThrough;

  it("tells a recipient declared late, a batch a pass, of what touches it, through the position it was declared at", async () => {
    await append("ProcessingRestricted", { categories: ["contact"] });
    await append("Note", {}, "c-1", "customer");
    await append("ProcessingRestricted", { categories: ["invoices"] });
    await append("PersonalDataRedacted", { categories: ["profile"] });
    await append("PersonalDataRedacted", { categories: ["profile"] });
    await storage.recipients.declare(
      [{ port: "customer.mailer", categories: ["contact"] }],
      4,
      "t",
    );
    await storage.recipients.declare([{ port: "order.gone", categories: ["contact"] }], 4, "t");
    await storage.recipients.declare(
      [{ port: "customer.newsletter", categories: ["contact"] }],
      4,
      "t",
    );
    const { delivered, delivery } = recorded();
    const catchUp = catchUpOf(delivery);
    expect(await catchUp.sweep()).toBe(1);
    expect(await caughtUp("customer.mailer")).toBe(2);
    expect(await catchUp.sweep()).toBe(1);
    expect(await caughtUp("customer.mailer")).toBe(4);
    expect(await catchUp.sweep()).toBe(0);
    expect(delivered).toEqual([
      ["customer.mailer", "ProcessingRestricted", true],
      ["customer.mailer", "PersonalDataRedacted", true],
    ]);
    expect(await caughtUp("order.gone")).toBe(0);
    expect(await caughtUp("customer.newsletter")).toBe(0);
  });

  it("stops before an event it holds, and is done at once with a store that ends before the position", async () => {
    const first = await append("ProcessingRestricted", { categories: ["contact"] });
    const second = await append("ProcessingRestricted", { categories: ["contact"] });
    await storage.recipients.declare(
      [{ port: "customer.mailer", categories: ["contact"] }],
      9,
      "t",
    );
    const held = recorded(second.id);
    expect(await catchUpOf(held.delivery, 5).sweep()).toBe(1);
    expect(await caughtUp("customer.mailer")).toBe(first.position);
    const rest = recorded();
    expect(await catchUpOf(rest.delivery, 5).sweep()).toBe(1);
    expect(await caughtUp("customer.mailer")).toBe(9);
    expect(rest.delivered).toEqual([["customer.mailer", "ProcessingRestricted", true]]);
  });

  it("tells nothing past the position it was declared at, nor an event of the app's named like the runtime's", async () => {
    await append("ProcessingRestricted", { categories: ["contact"] });
    await append("ProcessingRestricted", { categories: ["contact"] }, "c-1", "customer");
    await append("ProcessingRestricted", { categories: ["contact"] });
    await storage.recipients.declare(
      [{ port: "customer.mailer", categories: ["contact"] }],
      2,
      "t",
    );
    const { delivered, delivery } = recorded();
    expect(await catchUpOf(delivery, 5).sweep()).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(await caughtUp("customer.mailer")).toBe(2);
  });

  it("stops before the first event it holds in a full batch", async () => {
    await append("ProcessingRestricted", { categories: ["contact"] });
    const second = await append("ProcessingRestricted", { categories: ["contact"] });
    await append("ProcessingRestricted", { categories: ["contact"] });
    await storage.recipients.declare(
      [{ port: "customer.mailer", categories: ["contact"] }],
      9,
      "t",
    );
    expect(await catchUpOf(recorded(second.id).delivery).sweep()).toBe(1);
    expect(await caughtUp("customer.mailer")).toBe(second.position - 1);
  });
});
