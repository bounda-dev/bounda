import { describe, expect, it } from "vitest";
import { ValidationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { CommandPayloadArgs, EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { createTestApp, expectForgotten } from "../../testing/index.ts";
import { PROCESS_EVENTS } from "../process/lifecycle.ts";
import { SCHEDULED_COMMAND_FAILED_EVENT } from "../system-events.ts";
import { isSealed } from "./crypto.ts";

interface Builders {
  readonly [name: string]: (payload?: unknown) => unknown;
}

interface Registered {
  readonly aggregateId: string;
  readonly payload: { readonly email: string | null };
}

let mailerDown = true;
// Thrown as a plain string, which carries nothing of what the run read.
let asString = false;
// Runs once, inside the first handler that fails, before it throws.
let whileFailing: (() => Promise<unknown>) | null = null;

// Every handler quotes the personal field it read, as a careless one does.
const refuse = async (email: string | null): Promise<never> => {
  const run = whileFailing;
  whileFailing = null;
  await run?.();
  const message = `mailer refuses ${email ?? "nobody"}`;
  if (asString) throw message;
  throw new ValidationError(message, []);
};

const registry = {
  aggregates: {
    customer: {
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ email: personal(z.email()) }),
          evolve: () => ({}),
        },
        customerReminded: {
          payload: ({ z }: EventPayloadArgs) => z.object({}),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string(), email: z.email() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string } };
              events: Builders;
            }) => [events.customerRegistered?.(command.payload)],
          },
        },
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
              if (mailerDown) await refuse(command.payload.email);
              return [events.customerReminded?.({})];
            },
          },
        },
      },
      policies: {
        welcomeOnCustomerRegistered: {
          module: {
            handler: async ({ event }: { event: Registered }) => {
              if (mailerDown) await refuse(event.payload.email);
            },
          },
        },
        followUpOnCustomerRegistered: {
          module: {
            delay: "1m",
            handler: async ({ event }: { event: Registered }) => {
              if (mailerDown) await refuse(event.payload.email);
            },
          },
        },
      },
      processes: {
        onboarding: {
          module: {
            config: ({
              events,
            }: {
              events: { customer: { CustomerRegistered: string; CustomerReminded: string } };
            }) => ({
              startedBy: [events.customer.CustomerRegistered],
              completedBy: [events.customer.CustomerReminded],
              timeout: "48h",
            }),
            state: ({ z }: PayloadArgs) => z.object({ welcomed: z.boolean().default(false) }),
          },
          handlers: {
            customer: {
              customerRegistered: {
                handler: async ({ event }: { event: Registered }) => {
                  if (mailerDown) await refuse(event.payload.email);
                  return { welcomed: true };
                },
              },
            },
          },
        },
      },
    },
  },
  readModels: {},
} as const satisfies Registry;

const ana = { customerId: "c-1", email: "ana@example.com" };

const setup = async () => {
  mailerDown = true;
  asString = false;
  whileFailing = null;
  const adapter = memory();
  const storage = await adapter.createStorage();
  const { app, clock } = await createTestApp({
    registry,
    adapter,
    logger: silentLogger,
    config: {
      runtime: {
        policies: { retry: { strategy: "none" } },
        processes: { retry: { strategy: "none" } },
      },
    },
  });
  return { app, storage, clock };
};

describe("dead letters of work that names a person", () => {
  it("stores the error's text sealed under the person, never their data in the clear, and shows it opened", async () => {
    const { app, storage } = await setup();
    await app.commands.registerCustomer(ana);
    await app.commands.remindCustomer(ana, { delay: "1m" });
    await app.runUntilIdle();

    const stored = await storage.deadLetterStore.list();
    expect(stored.map((letter) => [letter.kind, letter.handler, letter.person])).toEqual([
      ["policy", "customer.welcomeOnCustomerRegistered", "c-1"],
      ["process", "customer.onboarding", "c-1"],
    ]);
    for (const letter of stored) {
      expect(isSealed(letter.errorMessage)).toBe(true);
      expect(isSealed(letter.errorStack)).toBe(true);
      expect(letter).toMatchObject({
        errorName: "ValidationError",
        errorCode: "VALIDATION_FAILED",
      });
    }
    expect(JSON.stringify(stored)).not.toContain("ana@example.com");

    const listed = await app.deadLetters.list();
    expect(listed.map((letter) => [letter.kind, letter.errorMessage])).toEqual([
      ["policy", "mailer refuses ana@example.com"],
      ["process", "mailer refuses ana@example.com"],
    ]);
    expect(listed[0]?.errorStack).toContain("mailer refuses ana@example.com");
    expect(listed[0]).not.toHaveProperty("payload");
    await app.stop();
  });

  it("seals a delayed policy's error under the person of the event it ran for", async () => {
    const { app, storage, clock } = await setup();
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    clock.advance(60_000);
    await app.runUntilIdle();
    const [delayed] = await storage.deadLetterStore.list({
      handler: "customer.followUpOnCustomerRegistered",
    });
    expect(delayed).toMatchObject({ kind: "policy", person: "c-1", errorName: "ValidationError" });
    expect(isSealed(delayed?.errorMessage)).toBe(true);
    expect(JSON.stringify(delayed)).not.toContain("ana@example.com");
    expect(
      (await app.deadLetters.list({ handler: "customer.followUpOnCustomerRegistered" }))[0]
        ?.errorMessage,
    ).toBe("mailer refuses ana@example.com");
    await app.stop();
  });

  it("seals a scheduled command's error under the person its payload names, and keeps ProcessFailed and ScheduledCommandFailed without the text", async () => {
    const { app, storage, clock } = await setup();
    await app.commands.registerCustomer(ana);
    await app.commands.remindCustomer(ana, { delay: "1m" });
    await app.runUntilIdle();
    clock.advance(60_000);
    await app.runUntilIdle();

    const [scheduled] = await storage.deadLetterStore.list({ kind: "scheduled" });
    expect(scheduled).toMatchObject({
      person: "c-1",
      errorName: "ValidationError",
      errorCode: "VALIDATION_FAILED",
      persons: [{ person: "c-1", fingerprint: expect.any(String) }],
    });
    expect(isSealed(scheduled?.errorMessage)).toBe(true);
    expect(JSON.stringify(await storage.deadLetterStore.list())).not.toContain("ana@example.com");
    expect(JSON.stringify(await app.events.read())).not.toContain("ana@example.com");

    const events = await app.events.read();
    expect(events.find((event) => event.type === SCHEDULED_COMMAND_FAILED_EVENT)?.payload).toEqual({
      commandType: "RemindCustomer",
      errorName: "ValidationError",
      errorCode: "VALIDATION_FAILED",
      attempts: 1,
    });
    expect(events.find((event) => event.type === PROCESS_EVENTS.failed)?.payload).toEqual({
      eventId: expect.any(String),
      errorName: "ValidationError",
      errorCode: "VALIDATION_FAILED",
      letterId: expect.any(String),
    });
    expect(
      await storage.inboxLedger.get({
        handler: "customer.onboarding",
        eventId: events[0]?.id ?? "",
      }),
    ).toMatchObject({
      lastError: "ValidationError (VALIDATION_FAILED)",
    });
    await app.stop();
  });

  it("reads the text as null once the person is forgotten, keeps the letters, and still retries the process", async () => {
    const { app } = await setup();
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    const before = await app.deadLetters.list();
    expect(before.map((letter) => letter.errorMessage)).toEqual([
      "mailer refuses ana@example.com",
      "mailer refuses ana@example.com",
    ]);
    const exported = async () =>
      (await app.exportPersonalData("c-1")).deadLetters.map((letter) => [
        letter.id,
        letter.kind,
        letter.errorMessage,
      ]);
    expect(await exported()).toEqual(
      before.map((letter) => [letter.id, letter.kind, "mailer refuses ana@example.com"]),
    );

    await app.forget("c-1");
    await app.runUntilIdle();
    expect(await exported()).toEqual(before.map((letter) => [letter.id, letter.kind, null]));
    const after = await app.deadLetters.list();
    expect(
      after.map((letter) => [letter.id, letter.status, letter.errorMessage, letter.errorStack]),
    ).toEqual(before.map((letter) => [letter.id, "failed", null, null]));
    expect(after.map((letter) => letter.errorName)).toEqual(["ValidationError", "ValidationError"]);
    await expectForgotten(app, "c-1");

    mailerDown = false;
    const process = after.find((letter) => letter.kind === "process");
    expect(await app.deadLetters.retry(process?.id ?? "")).toMatchObject({
      status: "retried",
      errorMessage: null,
      parked: 0,
    });
    const types = (await app.events.read()).map((event) => event.type);
    expect(types).toContain(PROCESS_EVENTS.resumed);
    expect(await app.deadLetters.get(process?.id ?? "")).toMatchObject({
      status: "retried",
      errorMessage: null,
    });
    await app.stop();
  });

  it("keeps the text in the clear for work that names nobody", async () => {
    const { app, storage } = await setup();
    await app.commands.registerCustomer(ana);
    await app.forget("c-1");
    await app.runUntilIdle();
    const stored = await storage.deadLetterStore.list();
    expect(stored.map((letter) => [letter.person, letter.errorMessage])).toEqual([
      [null, "mailer refuses nobody"],
      [null, "mailer refuses nobody"],
    ]);
    expect((await app.deadLetters.list()).map((letter) => letter.errorMessage)).toEqual([
      "mailer refuses nobody",
      "mailer refuses nobody",
    ]);
    await app.stop();
  });

  it("keeps unreadable what a handler read before a forget that came while it failed, giving the person no key", async () => {
    const { app, storage } = await setup();
    whileFailing = () => app.forget("c-1");
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    const stored = await storage.deadLetterStore.list();
    expect(stored).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain("ana@example.com");
    expect(await storage.personalKeys.get("c-1")).toBeNull();
    // The handler that failed first read the email; the other read the event after the forget.
    const listed = await app.deadLetters.list();
    for (const [index, letter] of stored.entries()) {
      if (letter.person === "c-1") {
        expect(isSealed(letter.errorMessage)).toBe(true);
        expect(listed[index]?.errorMessage).toBeNull();
      } else {
        expect(letter.errorMessage).toBe("mailer refuses nobody");
      }
    }
    expect(stored.filter((letter) => letter.person === "c-1")).toHaveLength(1);
    await app.stop();
  });

  it("keeps unreadable what a handler read before its person was forgotten and keyed anew while it failed", async () => {
    const { app, storage } = await setup();
    whileFailing = async () => {
      await app.forget("c-1");
      await app.commands.registerCustomer({ customerId: "c-1", email: "ana@again.example" });
    };
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    expect(await storage.personalKeys.get("c-1")).not.toBeNull();
    const listed = await app.deadLetters.list();
    expect(JSON.stringify(listed)).not.toContain("ana@example.com");
    // The policy read the first registration under the key the forget removed, and the second
    // under the new one; the process read the first after the forget.
    expect(listed.map((letter) => [letter.kind, letter.person, letter.errorMessage])).toEqual([
      ["policy", "c-1", null],
      ["policy", "c-1", "mailer refuses ana@again.example"],
      ["process", null, "mailer refuses nobody"],
    ]);
    await app.stop();
  });

  it.each([
    ["an error", false],
    ["a string", true],
  ])(
    "keeps unreadable what a delayed policy that threw %s read before its person was forgotten and keyed anew while it failed",
    async (_, thrownAsString) => {
      const { app, clock } = await setup();
      asString = thrownAsString;
      await app.commands.registerCustomer(ana);
      await app.runUntilIdle();
      whileFailing = async () => {
        await app.forget("c-1");
        await app.commands.registerCustomer({ customerId: "c-1", email: "ana@again.example" });
      };
      clock.advance(60_000);
      await app.runUntilIdle();
      const listed = await app.deadLetters.list();
      expect(JSON.stringify(listed)).not.toContain("ana@example.com");
      const [delayed] = listed.filter(
        (letter) => letter.handler === "customer.followUpOnCustomerRegistered",
      );
      expect(delayed).toMatchObject({ person: "c-1", errorMessage: null });
      await app.stop();
    },
  );

  it("names the person a delayed policy read, even when they are forgotten while it fails", async () => {
    const { app, storage, clock } = await setup();
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    whileFailing = () => app.forget("c-1");
    clock.advance(60_000);
    await app.runUntilIdle();
    const [delayed] = await storage.deadLetterStore.list({
      handler: "customer.followUpOnCustomerRegistered",
    });
    expect(delayed).toMatchObject({ person: "c-1" });
    expect(isSealed(delayed?.errorMessage)).toBe(true);
    expect(JSON.stringify(delayed)).not.toContain("ana@example.com");
    expect(await storage.personalKeys.get("c-1")).toBeNull();
    await app.stop();
  });
});
