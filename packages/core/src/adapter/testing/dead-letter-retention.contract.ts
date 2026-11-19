import { afterEach, describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { type BoundaApp, createApp } from "../../kernel/app.ts";
import { HELD_RECHECK_MS } from "../../kernel/personal-data/held-text.ts";
import { masterKey } from "../../kernel/personal-data/master-key.ts";
import { defineTenantKeyStore } from "../../kernel/personal-data/tenant-key-source.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { Adapter } from "../adapter.ts";

export interface DeadLetterRetentionContractArgs {
  /**
   * A fresh, empty database.
   */
  readonly create: () => Promise<Adapter>;
}

export interface DeadLetterRetentionContractFunction {
  (args: DeadLetterRetentionContractArgs): void;
}

// The policy quotes the personal field it read while `failing.on`.
const failing = { on: false };

const registry = {
  aggregates: {
    customer: {
      stateFingerprint: "dead-letter-retention-contract",
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
      policies: {
        welcomeCustomer: {
          module: {
            on: "CustomerRegistered",
            handler: ({
              event,
            }: {
              event: StoredEvent<"CustomerRegistered", { email: string | null }>;
            }) => {
              if (failing.on) {
                throw new ValidationError(`cannot welcome ${event.payload.email ?? "nobody"}`, []);
              }
            },
          },
        },
      },
      processes: {},
    },
  },
  readModels: {},
} as unknown as Registry;

const DAY = 86_400_000;

/**
 * How every storage adapter keeps resolved dead letters for no longer than
 * `runtime.deadLetters.retention`: removed once past it, kept while a person whose data they hold
 * is restricted, and no longer once that person was forgotten. Call it inside a `describe` of the
 * adapter's test file.
 */
export const deadLetterRetentionContract: DeadLetterRetentionContractFunction = ({ create }) => {
  describe("dead letter retention contract", () => {
    const stops: (() => Promise<void>)[] = [];

    afterEach(async () => {
      failing.on = false;
      for (const stop of stops.splice(0)) await stop();
    });

    // A letter of c-1's, discarded, and when it comes due.
    const resolvedLetter = async () => {
      const adapter = await create();
      const clock = createFixedClock(new Date("2026-05-01T00:00:00.000Z"));
      const app: BoundaApp<Registry> = await createApp<Registry>({
        registry,
        config: {
          storage: adapter,
          runtime: {
            deadLetters: { retention: "1d" },
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
      await app.runUntilIdle();
      failing.on = false;
      const [letter] = await app.deadLetters.list();
      if (letter === undefined) throw new Error("no dead letter");
      expect(letter).toMatchObject({
        person: "c-1",
        errorMessage: "cannot welcome c-1@example.com",
      });
      await app.deadLetters.discard(letter.id);
      const kept = async () => (await adapter.createStorage()).deadLetterStore.list();
      expect(await kept()).toEqual([
        expect.objectContaining({ person: "c-1", resolvedAt: clock.now().toISOString() }),
      ]);
      return { app, clock, kept, id: letter.id, due: new Date(clock.now().getTime() + DAY) };
    };

    it("removes a resolved letter past the retention, kept while its person is restricted", async () => {
      const { app, clock, kept, due } = await resolvedLetter();
      expect(await app.nextDueAt()).toEqual(due);
      await app.restrict("c-1", { ground: "legal-claims" });
      clock.set(due);
      await app.runUntilIdle();
      expect(await kept()).toHaveLength(1);
      expect((await app.status()).deadLetterRetention).toMatchObject({ held: 1 });
      await app.unrestrict("c-1", { notice: "given" });
      clock.set(new Date(due.getTime() + HELD_RECHECK_MS));
      await app.runUntilIdle();
      expect(await kept()).toEqual([]);
    });

    it("removes the letter of a person forgotten while restricted, whose restriction outlives them", async () => {
      const { app, clock, kept, id, due } = await resolvedLetter();
      await app.restrict("c-1", { ground: "legal-claims" });
      await app.forget("c-1");
      await app.runUntilIdle();
      expect(await app.deadLetters.get(id, { includeRestricted: "legal-claims" })).toMatchObject({
        errorMessage: null,
      });
      clock.set(due);
      await app.runUntilIdle();
      expect(await kept()).toEqual([]);
      expect((await app.status()).deadLetterRetention).toMatchObject({ held: 0 });
    });
  });
};
