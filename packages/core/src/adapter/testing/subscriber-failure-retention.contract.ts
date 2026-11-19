import { afterEach, describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { type BoundaApp, createApp } from "../../kernel/app.ts";
import { HELD_FAILURE_RECHECK_MS } from "../../kernel/dispatch/failure-retention.ts";
import { masterKey } from "../../kernel/personal-data/master-key.ts";
import { defineTenantKeyStore } from "../../kernel/personal-data/tenant-key-source.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import type { PersonalDataForgottenEvent } from "../../modules/bounda-events.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import type { Adapter } from "../adapter.ts";
import type { Table } from "../storage/table.ts";

export interface SubscriberFailureRetentionContractArgs {
  /**
   * A fresh, empty database.
   */
  readonly create: () => Promise<Adapter>;
}

export interface SubscriberFailureRetentionContractFunction {
  (args: SubscriberFailureRetentionContractArgs): void;
}

interface CustomerRow {
  readonly customerId: string;
  readonly email: string;
}

// The projection quotes the personal field it read while `failing.on`.
const failing = { on: false };

const registry = {
  aggregates: {
    customer: {
      stateFingerprint: "subscriber-failure-retention-contract",
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ email: personal(z.string()) }),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({ customerId: notPersonal(z.string()), email: notPersonal(z.string()) }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerRegistered?.({ email: command.payload.email })],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {
    customers: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().notPersonal(),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: async ({
              event,
              table,
            }: {
              event: StoredEvent<"CustomerRegistered", { email: string | null }>;
              table: Table<CustomerRow>;
            }) => {
              if (failing.on) throw new Error(`cannot project ${event.payload.email ?? "nobody"}`);
              await table.upsert({
                customerId: event.aggregateId,
                email: event.payload.email ?? "",
              });
            },
          },
        },
        bounda: {
          personalDataForgotten: {
            project: async ({
              event,
              table,
            }: {
              event: PersonalDataForgottenEvent;
              table: Table<CustomerRow>;
            }) => {
              await table.delete({ customerId: event.payload.personId });
            },
          },
        },
      },
      queries: {},
    },
  },
} as unknown as Registry;

const DAY = 86_400_000;

/**
 * How every storage adapter keeps the subscribers' last failures for no longer than
 * `runtime.subscriberFailures.retention`: removed once past it, kept while a person their text
 * opens for is restricted, and no longer once that person was forgotten. Call it inside a
 * `describe` of the adapter's test file.
 */
export const subscriberFailureRetentionContract: SubscriberFailureRetentionContractFunction = ({
  create,
}) => {
  describe("subscriber failure retention contract", () => {
    const stops: (() => Promise<void>)[] = [];

    afterEach(async () => {
      failing.on = false;
      for (const stop of stops.splice(0)) await stop();
    });

    // A failure of c-1's, resolved, and when it comes due.
    const resolvedFailure = async () => {
      const adapter = await create();
      const clock = createFixedClock(new Date("2026-05-01T00:00:00.000Z"));
      const app: BoundaApp<Registry> = await createApp<Registry>({
        registry,
        config: {
          storage: adapter,
          runtime: {
            subscriberFailures: { retention: "1d" },
            personalData: {
              keyWrapper: masterKey({ from: "RETENTION_KEY" }),
              tenantKeys: defineTenantKeyStore(() => createMemoryTenantKeyStore()),
            },
          },
        },
        ids: createSequentialIdGenerator({ prefix: "retention" }),
        clock,
        env: { RETENTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) },
      });
      stops.push(() => app.stop());
      failing.on = true;
      await app.commands.registerCustomer?.({ customerId: "c-1", email: "c-1@example.com" });
      await app.runUntilIdle({ maxPasses: 3 });
      failing.on = false;
      await app.runUntilIdle();
      const kept = async () => (await adapter.createStorage()).subscriberFailures.list();
      expect(await kept()).toEqual([
        expect.objectContaining({ person: "c-1", resolvedAt: clock.now().toISOString() }),
      ]);
      return { app, clock, kept, due: new Date(clock.now().getTime() + DAY) };
    };

    it("removes a resolved failure past the retention, kept while its person is restricted", async () => {
      const { app, clock, kept, due } = await resolvedFailure();
      expect(await app.nextDueAt()).toEqual(due);
      await app.restrict("c-1", { ground: "legal-claims" });
      clock.set(due);
      await app.runUntilIdle();
      expect(await kept()).toHaveLength(1);
      expect((await app.status()).subscriberFailureRetention).toMatchObject({ held: 1 });
      await app.unrestrict("c-1", { notice: "given" });
      clock.set(new Date(due.getTime() + HELD_FAILURE_RECHECK_MS));
      await app.runUntilIdle();
      expect(await kept()).toEqual([]);
    });

    it("removes the failure of a person forgotten while restricted, whose restriction outlives them", async () => {
      const { app, clock, kept, due } = await resolvedFailure();
      await app.restrict("c-1", { ground: "legal-claims" });
      await app.forget("c-1");
      await app.runUntilIdle();
      expect(await app.subscriberFailures.get("projection:customers")).toMatchObject({
        errorMessage: null,
      });
      clock.set(due);
      await app.runUntilIdle();
      expect(await kept()).toEqual([]);
      expect((await app.status()).subscriberFailureRetention).toMatchObject({ held: 0 });
    });
  });
};
