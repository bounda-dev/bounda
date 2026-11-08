import { describe, expect, it } from "vitest";
import { silentLogger } from "../../contracts/logger.ts";
import type { EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { createTestApp } from "../../testing/index.ts";

interface Builders {
  readonly [name: string]: (payload?: unknown) => unknown;
}

interface Commands {
  readonly [name: string]: (payload: unknown) => Promise<unknown>;
}

interface CustomerState {
  readonly email: string | null;
}

const registry = {
  aggregates: {
    customer: {
      state: { initialState: { email: null } satisfies CustomerState },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ email: personal(z.email()) }),
          evolve: ({ event }: { event: { payload: { email: string | null } } }) => ({
            email: event.payload.email,
          }),
        },
        customerTouched: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ note: personal(z.string()).optional() }),
          evolve: ({ state }: { state: CustomerState }) => state,
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
        touchCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
            handler: ({ events }: { events: Builders }) => [events.customerTouched?.({})],
          },
        },
        // Quotes what its state holds of the customer, in a plain string.
        checkCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
            handler: ({ state }: { state: CustomerState }) => {
              throw `cannot check ${state.email ?? "nobody"}`;
            },
          },
        },
      },
      policies: {
        checkOnCustomerTouched: {
          module: {
            handler: ({
              event,
              commands,
            }: {
              event: { aggregateId: string };
              commands: Commands;
            }) => commands.checkCustomer?.({ customerId: event.aggregateId }),
          },
        },
      },
      processes: {},
    },
  },
  readModels: {},
} as const satisfies Registry;

const setup = () =>
  createTestApp({
    registry,
    logger: silentLogger,
    config: { runtime: { policies: { retry: { strategy: "none" } } } },
  });

describe("a value a reaction throws that is no error", () => {
  it("is recorded in its letter as itself, and is what a retry of the letter rejects with", async () => {
    const { app } = await setup();
    await app.commands.registerCustomer({ customerId: "c-1", email: "ana@example.com" });
    await app.commands.touchCustomer({ customerId: "c-1" });
    await app.runUntilIdle();
    const [letter] = await app.deadLetters.list();
    expect(letter).toMatchObject({
      errorName: "string",
      errorMessage: "cannot check ana@example.com",
    });
    expect(letter).not.toHaveProperty("errorCode");
    expect(letter).not.toHaveProperty("errorStack");
    await expect(app.deadLetters.retry(letter?.id ?? "")).rejects.toBe(
      "cannot check ana@example.com",
    );
    await app.stop();
  });
});
