import { describe, expect, it } from "vitest";
import { ValidationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import type { CommandPayloadArgs, EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { createTestApp } from "../../testing/index.ts";

interface Builders {
  readonly [name: string]: (payload?: unknown) => unknown;
}

interface Commands {
  readonly [name: string]: (payload: unknown) => Promise<unknown>;
}

interface Registered {
  readonly aggregateId: string;
  readonly payload: { readonly email: string | null };
}

// Runs once, inside the first handler that fails, before it throws.
let whileFailing: (() => Promise<unknown>) | null = null;
// Runs once, inside `notify`'s handler, between its load and its append.
let whileNotifying: (() => Promise<unknown>) | null = null;
// The reaction whose mailer is down.
let failing: "policy" | "process" | null = null;

// Reminds the person, then quotes the field it read, as a careless handler does.
const remind = async (
  reaction: "policy" | "process",
  commands: Commands,
  { aggregateId, payload }: Registered,
) => {
  await commands.notify?.({ notificationId: `n-${aggregateId}`, customerId: aggregateId });
  if (failing !== reaction) return;
  const run = whileFailing;
  whileFailing = null;
  await run?.();
  throw new ValidationError(`mailer refuses ${payload.email ?? "nobody"}`, []);
};

const registry = {
  aggregates: {
    customer: {
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ email: personal(z.email()) }),
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
      },
      policies: {
        remindOnCustomerRegistered: {
          module: {
            handler: ({ event, commands }: { event: Registered; commands: Commands }) =>
              remind("policy", commands, event),
          },
        },
      },
      processes: {
        onboarding: {
          module: {
            config: ({ events }: { events: { customer: { CustomerRegistered: string } } }) => ({
              startedBy: [events.customer.CustomerRegistered],
              timeout: "48h",
            }),
            state: ({ z }: PayloadArgs) => z.object({ reminded: z.boolean().default(false) }),
          },
          handlers: {
            customer: {
              customerRegistered: {
                handler: async ({ event, commands }: { event: Registered; commands: Commands }) => {
                  await remind("process", commands, event);
                  return { reminded: true };
                },
              },
            },
          },
        },
      },
    },
    // A stream of its own per notification, holding nothing of the person, and events that name
    // nobody: what the reaction read of them comes from the event alone, and only the command's
    // mark says whom it touches.
    notification: {
      events: {
        notified: {
          payload: ({ z }: EventPayloadArgs) => z.object({ customerId: z.string() }),
          evolve: () => ({}),
        },
      },
      commands: {
        notify: {
          module: {
            payload: ({ z, person }: CommandPayloadArgs) =>
              z.object({ notificationId: z.string(), customerId: person(z.string()) }),
            handler: async ({
              command,
              events,
            }: {
              command: { payload: { customerId: string } };
              events: Builders;
            }) => {
              const run = whileNotifying;
              whileNotifying = null;
              await run?.();
              return [events.notified?.({ customerId: command.payload.customerId })];
            },
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as const satisfies Registry;

describe("work running when a person is restricted", () => {
  it.each([
    ["policy", "customer.remindOnCustomerRegistered"],
    ["process", "customer.onboarding"],
  ] as const)(
    "keeps unreadable what a %s read before its person was forgotten and keyed anew while it failed again",
    async (reaction, handler) => {
      failing = null;
      whileFailing = null;
      const { app } = await createTestApp({
        registry,
        logger: silentLogger,
        config: {
          runtime: {
            policies: { retry: { strategy: "none" } },
            processes: { retry: { strategy: "none" } },
          },
        },
      });
      await app.commands.registerCustomer({ customerId: "c-1", email: "ana@example.com" });
      await app.restrict("c-1");
      await app.runUntilIdle();
      const refused = (await app.deadLetters.list()).find((letter) => letter.handler === handler);
      expect(refused).toMatchObject({ errorCode: "PROCESSING_RESTRICTED", person: "c-1" });

      failing = reaction;
      whileFailing = async () => {
        await app.forget("c-1");
        await app.commands.registerCustomer({ customerId: "c-1", email: "ana@again.example" });
      };
      await app.unrestrict("c-1");
      await app.runUntilIdle();
      expect(whileFailing).toBeNull();
      const again = (await app.deadLetters.list()).find((letter) => letter.id === refused?.id);
      expect(again).toMatchObject({
        errorCode: "VALIDATION_FAILED",
        person: "c-1",
        errorMessage: null,
      });
      await app.stop();
    },
  );

  it("refuses a command running when restrict commits, though its events name nobody", async () => {
    const { app } = await createTestApp({ registry, logger: silentLogger });
    whileNotifying = () => app.restrict("c-1");
    await expect(
      app.commands.notify({ notificationId: "n-1", customerId: "c-1" }),
    ).rejects.toMatchObject({ code: "PROCESSING_RESTRICTED", personId: "c-1" });
    expect(whileNotifying).toBeNull();
    expect((await app.events.read()).map((event) => event.type)).toEqual(["ProcessingRestricted"]);
    await app.stop();
  });
});
