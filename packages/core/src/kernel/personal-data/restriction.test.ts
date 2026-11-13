import { describe, expect, it, vi } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { PersonStore } from "../../adapter/storage/person-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import {
  ConcurrencyError,
  ProcessingRestrictedError,
  ValidationError,
} from "../../contracts/errors.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { memory } from "../../memory/index.ts";
import type { RestrictOptions, UnrestrictOptions } from "../../modules/personal-data.ts";
import { createRecordingLogger } from "../test-support.ts";
import { buildPersonalCategories } from "./categories.ts";
import {
  opensRequested,
  refuseRestricted,
  refuseRestrictedRead,
  restrictedPersonOf,
} from "./refusal.ts";
import {
  LIFT_RESTRICTION_COMMAND,
  liftAnnounced,
  liftRestrictionKey,
  processingRestrictionsOf,
  restrictAgain,
  restrictProcessing,
  unrestrictProcessing,
} from "./restriction.ts";

const categories = buildPersonalCategories({
  module: {
    categories: {
      marketing: { basis: "consent", retention: "730d" },
      invoices: { basis: "legal-obligation", retention: "6y" },
    },
  },
  retention: null,
});

const setup = async (storage?: Storage) => {
  const live = storage ?? (await memory().createStorage());
  const { logger, entries: logs } = createRecordingLogger();
  const clock = createFixedClock();
  const ids = createSequentialIdGenerator();
  const recorded: ForgetLedgerEntry[] = [];
  const intentions = {
    record: async (entry: ForgetLedgerEntry) => {
      recorded.push(entry);
    },
  };
  const base = (personId: string) => ({
    storage: live,
    ids,
    clock,
    logger,
    concurrencyRetries: 2,
    personId,
    categories,
    intentions,
  });
  return {
    storage: live,
    clock,
    logs,
    ids,
    logger,
    intentions,
    recorded,
    restrict: (personId: string, options: RestrictOptions = { ground: "accuracy-contested" }) =>
      restrictProcessing({ ...base(personId), options }),
    unrestrict: (personId: string, options: UnrestrictOptions = { notice: "given" }) =>
      unrestrictProcessing({ ...base(personId), options }),
  };
};

const events = (storage: Storage) => storage.eventStore.readAll({ afterPosition: 0, limit: 50 });

describe("processingRestrictionsOf", () => {
  it("says one restriction per ground, in the order of article 18(1), since its oldest row", () => {
    expect(
      processingRestrictionsOf([
        { ground: "legal-claims", category: "invoices", since: "2026-01-02T00:00:00.000Z" },
        { ground: "accuracy-contested", category: "profile", since: "2026-01-03T00:00:00.000Z" },
        { ground: "accuracy-contested", category: "contact", since: "2026-01-01T00:00:00.000Z" },
        { ground: "objection-pending", category: null, since: "2026-01-04T00:00:00.000Z" },
      ]),
    ).toEqual([
      {
        ground: "accuracy-contested",
        categories: ["contact", "profile"],
        since: "2026-01-01T00:00:00.000Z",
      },
      { ground: "legal-claims", categories: ["invoices"], since: "2026-01-02T00:00:00.000Z" },
      { ground: "objection-pending", categories: null, since: "2026-01-04T00:00:00.000Z" },
    ]);
    expect(processingRestrictionsOf([])).toEqual([]);
    expect(
      processingRestrictionsOf([
        { ground: "legal-claims", category: "invoices", since: "2026-01-02T00:00:00.000Z" },
        { ground: "legal-claims", category: null, since: "2026-01-03T00:00:00.000Z" },
      ]),
    ).toEqual([{ ground: "legal-claims", categories: null, since: "2026-01-02T00:00:00.000Z" }]);
  });
});

describe("restrictProcessing", () => {
  it("records the restriction and appends ProcessingRestricted with every restriction the person has, answering like a command", async () => {
    const { storage, restrict, logs } = await setup();
    expect(await restrict("c-1")).toEqual({
      scheduled: false,
      aggregateType: "bounda",
      aggregateId: "c-1",
      version: 1,
      eventIds: ["id-2"],
      eventTypes: ["ProcessingRestricted"],
      position: 1,
    });
    expect(await storage.persons.get("c-1")).toMatchObject({
      person: "c-1",
      restrictedSince: "2026-01-01T00:00:00.000Z",
    });
    expect(await events(storage)).toEqual([
      {
        id: "id-2",
        aggregateType: "bounda",
        aggregateId: "c-1",
        version: 1,
        position: 1,
        type: "ProcessingRestricted",
        payload: {
          personId: "c-1",
          ground: "accuracy-contested",
          categories: null,
          restrictions: [
            { ground: "accuracy-contested", categories: null, since: "2026-01-01T00:00:00.000Z" },
          ],
        },
        person: "c-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        metadata: {
          correlationId: "id-1",
          causationId: "id-1",
          depth: 0,
          schemaVersion: 1,
          system: true,
        },
      },
    ]);
    expect(await storage.scheduler.list()).toEqual([]);
    expect(logs).toEqual([
      {
        level: "info",
        message: "processing restricted",
        fields: { personId: "c-1", ground: "accuracy-contested", changed: true },
      },
    ]);
  });

  it("restricts categories, each once, and adds a ground beside another", async () => {
    const { storage, clock, restrict } = await setup();
    await restrict("c-1", { ground: "objection-pending", categories: ["marketing", "marketing"] });
    clock.advance(1_000);
    expect(
      (await restrict("c-1", { ground: "objection-pending", categories: ["marketing"] })).eventIds,
    ).toEqual([]);
    await restrict("c-1", { ground: "legal-claims", categories: ["invoices"] });
    const [, second] = await events(storage);
    expect(second?.payload).toEqual({
      personId: "c-1",
      ground: "legal-claims",
      categories: ["invoices"],
      restrictions: [
        { ground: "legal-claims", categories: ["invoices"], since: "2026-01-01T00:00:01.000Z" },
        {
          ground: "objection-pending",
          categories: ["marketing"],
          since: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("restricts as a whole a ground restricted in categories, replacing them, beside the other grounds", async () => {
    const { storage, clock, restrict, recorded } = await setup();
    await restrict("c-1", { ground: "legal-claims" });
    clock.advance(1_000);
    await restrict("c-1", { ground: "objection-pending", categories: ["marketing"] });
    clock.advance(1_000);
    await restrict("c-1", { ground: "objection-pending" });
    const [, , third] = await events(storage);
    expect(third?.payload).toMatchObject({
      restrictions: [
        { ground: "legal-claims", categories: null, since: "2026-01-01T00:00:00.000Z" },
        { ground: "objection-pending", categories: null, since: "2026-01-01T00:00:02.000Z" },
      ],
    });
    expect(recorded.map(({ reason, eventId }) => [reason, eventId])).toEqual([
      ["requested", "id-2"],
      ["requested", "id-4"],
      ["requested", "id-6"],
    ]);
    await restrict("c-1", { ground: "objection-pending", categories: ["invoices"] });
    expect(recorded).toHaveLength(3);
  });

  it("restricts a person once: the second time appends nothing and answers the stream as it is", async () => {
    const { storage, clock, restrict, logs } = await setup();
    await restrict("c-1");
    clock.advance(1_000);
    expect(await restrict("c-1")).toEqual({
      scheduled: false,
      aggregateType: "bounda",
      aggregateId: "c-1",
      version: 1,
      eventIds: [],
      eventTypes: [],
      position: 0,
    });
    expect((await storage.persons.get("c-1"))?.restrictedSince).toBe("2026-01-01T00:00:00.000Z");
    expect(await storage.eventStore.lastPosition()).toBe(1);
    expect(logs.at(-1)?.fields).toEqual({
      personId: "c-1",
      ground: "accuracy-contested",
      changed: false,
    });
  });

  it("cancels the lift announced on its ground, and only that one", async () => {
    const { storage, restrict, unrestrict } = await setup();
    await restrict("c-1", { ground: "accuracy-contested" });
    await restrict("c-1", { ground: "objection-pending", categories: ["marketing"] });
    await unrestrict("c-1", { notice: "7d" });
    expect((await storage.scheduler.list()).map(({ dedupeKey }) => dedupeKey)).toEqual([
      liftRestrictionKey("c-1", "accuracy-contested", null),
      liftRestrictionKey("c-1", "objection-pending", null),
    ]);
    await restrict("c-1", { ground: "objection-pending", categories: ["invoices"] });
    expect((await storage.scheduler.list()).map(({ dedupeKey }) => dedupeKey)).toEqual([
      liftRestrictionKey("c-1", "accuracy-contested", null),
    ]);
  });

  it("refuses an empty id, a ground article 18(1) does not name, and categories empty or unknown", async () => {
    const { storage, restrict, unrestrict } = await setup();
    await expect(restrict("")).rejects.toThrow(
      new ValidationError("restrict needs the id of the person", [
        { path: ["personId"], message: "Expected a non-empty string" },
      ]),
    );
    await expect(unrestrict(undefined as unknown as string)).rejects.toThrow(
      new ValidationError("unrestrict needs the id of the person", [
        { path: ["personId"], message: "Expected a non-empty string" },
      ]),
    );
    await expect(
      restrict("c-1", { ground: "because" } as unknown as RestrictOptions),
    ).rejects.toThrow(
      new ValidationError("restrict needs a ground of article 18(1)", [
        {
          path: ["ground"],
          message:
            'Expected one of "accuracy-contested", "unlawful-processing", "legal-claims", "objection-pending"',
        },
      ]),
    );
    await expect(restrict("c-1", null as unknown as RestrictOptions)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(restrict("c-1", { ground: "legal-claims", categories: [] })).rejects.toThrow(
      "restrict needs at least one category when it names them",
    );
    await expect(
      restrict("c-1", { ground: "legal-claims", categories: ["profile"] as never }),
    ).rejects.toThrow('restrict names categories the app does not have: "profile"');
    expect(await storage.eventStore.lastPosition()).toBe(0);
  });

  it("runs again when the person's stream moved under it, and gives up past the retries", async () => {
    const base = await memory().createStorage();
    let conflicts = 0;
    const racing: Storage = {
      ...base,
      transact: (work) =>
        base.transact(async (transaction) => {
          const result = await work(transaction);
          if (conflicts > 0) {
            conflicts -= 1;
            throw new ConcurrencyError({
              streamId: "bounda:c-1",
              expectedVersion: 0,
              actualVersion: 1,
            });
          }
          return result;
        }),
    };
    const { restrict, unrestrict } = await setup(racing);
    conflicts = 2;
    expect((await restrict("c-1")).version).toBe(1);
    expect((await base.persons.get("c-1"))?.restrictedSince).not.toBeNull();
    conflicts = 3;
    await expect(unrestrict("c-1")).rejects.toBeInstanceOf(ConcurrencyError);
    expect((await base.persons.get("c-1"))?.restrictedSince).not.toBeNull();
    expect(await base.scheduler.list()).toEqual([]);
  });
});

describe("a change of restrictions planned on rows that changed before it commits", () => {
  // Storage whose first reads outside the transaction answer `stale`, as rows read just before
  // another change committed would.
  const staleOnce = (live: Storage, stale: Awaited<ReturnType<PersonStore["restrictions"]>>) => {
    let reads = 0;
    return {
      ...live,
      persons: {
        ...live.persons,
        restrictions: async (person: string) => {
          reads += 1;
          return reads === 1 ? stale : live.persons.restrictions(person);
        },
      },
    } satisfies Storage;
  };

  it("plans it again on the rows the transaction reads, under a new intention", async () => {
    const live = await memory().createStorage();
    const first = await setup(live);
    await first.restrict("c-1", { ground: "legal-claims" });
    const { restrict, recorded } = await setup(staleOnce(live, []));
    expect((await restrict("c-1", { ground: "objection-pending" })).eventTypes).toEqual([
      "ProcessingRestricted",
    ]);
    expect(recorded.map(({ restriction }) => restriction?.payload)).toEqual([
      expect.objectContaining({
        restrictions: [expect.objectContaining({ ground: "objection-pending" })],
      }),
      expect.objectContaining({
        restrictions: [
          expect.objectContaining({ ground: "legal-claims" }),
          expect.objectContaining({ ground: "objection-pending" }),
        ],
      }),
    ]);
    const last = (await events(live)).at(-1);
    expect(last?.id).toBe(recorded[1]?.eventId);
  });

  it("appends nothing when the rows already hold what it planned, and commits what rows that planned nothing now need", async () => {
    const live = await memory().createStorage();
    await (await setup(live)).restrict("c-1", { ground: "legal-claims" });
    const done = await setup(staleOnce(live, []));
    expect((await done.restrict("c-1", { ground: "legal-claims" })).eventIds).toEqual([]);
    expect(done.recorded).toHaveLength(1);
    const since = "2026-01-01T00:00:00.000Z";
    const pending = await setup(
      staleOnce(live, [{ ground: "objection-pending", category: null, since }]),
    );
    expect((await pending.restrict("c-1", { ground: "objection-pending" })).eventTypes).toEqual([
      "ProcessingRestricted",
    ]);
    expect(pending.recorded).toHaveLength(1);
    expect(await live.persons.restrictions("c-1")).toHaveLength(2);
  });
});

describe("unrestrictProcessing", () => {
  it('lifts at once with notice "given": removes the rows, appends ProcessingRestrictionLifted and schedules the retry of the letters, together', async () => {
    const { storage, clock, restrict, unrestrict, logs } = await setup();
    await restrict("c-1");
    clock.advance(60_000);
    expect(await unrestrict("c-1")).toEqual({
      scheduled: false,
      aggregateType: "bounda",
      aggregateId: "c-1",
      version: 2,
      eventIds: ["id-4"],
      eventTypes: ["ProcessingRestrictionLifted"],
      position: 2,
    });
    expect(await storage.persons.get("c-1")).toMatchObject({
      person: "c-1",
      restrictedSince: null,
    });
    const [, lifted] = await events(storage);
    expect(lifted).toMatchObject({
      type: "ProcessingRestrictionLifted",
      payload: {
        personId: "c-1",
        grounds: ["accuracy-contested"],
        categories: null,
        restrictions: [],
      },
      metadata: { correlationId: "id-3", causationId: "id-3", system: true },
    });
    expect(await storage.scheduler.list()).toEqual([
      {
        dedupeKey: "retry-restricted:c-1",
        command: {
          type: "bounda.RetryRestricted",
          aggregateId: "c-1",
          payload: { personId: "c-1" },
        },
        executeAt: "2026-01-01T00:01:00.000Z",
        context: { correlationId: "id-3", causationId: "id-4", depth: 0 },
        attempts: 0,
      },
    ]);
    expect(logs.at(-1)).toEqual({
      level: "info",
      message: "processing restriction lifted",
      fields: { personId: "c-1", changed: true },
    });
  });

  it("announces a lift with a notice, and schedules it per ground for when the notice runs out", async () => {
    const { storage, restrict, unrestrict, logs } = await setup();
    await restrict("c-1", { ground: "accuracy-contested", categories: ["marketing"] });
    await restrict("c-1", { ground: "legal-claims", categories: ["marketing", "invoices"] });
    expect(await unrestrict("c-1", { notice: "7d", categories: ["marketing"] })).toMatchObject({
      version: 3,
      eventTypes: ["ProcessingRestrictionLiftAnnounced"],
    });
    const [, , announced] = await events(storage);
    expect(announced).toMatchObject({
      id: "id-6",
      type: "ProcessingRestrictionLiftAnnounced",
      payload: {
        personId: "c-1",
        grounds: ["accuracy-contested", "legal-claims"],
        categories: ["marketing"],
        liftsAt: "2026-01-08T00:00:00.000Z",
      },
    });
    expect(await storage.scheduler.list()).toEqual(
      ["accuracy-contested", "legal-claims"].map((ground) => ({
        dedupeKey: liftRestrictionKey("c-1", ground as "legal-claims", "marketing"),
        command: {
          type: LIFT_RESTRICTION_COMMAND,
          aggregateId: "c-1",
          payload: { personId: "c-1", ground, categories: ["marketing"] },
        },
        executeAt: "2026-01-08T00:00:00.000Z",
        context: { correlationId: "id-5", causationId: "id-6", depth: 0 },
        attempts: 0,
      })),
    );
    expect(await storage.persons.restrictions("c-1")).toHaveLength(3);
    expect(logs.at(-1)?.message).toBe("processing restriction lift announced");
  });

  it("lifts what an announcement scheduled once it comes due, as whoever announced it", async () => {
    const { storage, clock, ids, logger, intentions, restrict, unrestrict } = await setup();
    await restrict("c-1", { ground: "legal-claims", categories: ["marketing", "invoices"] });
    await unrestrict("c-1", { notice: "1d", categories: ["marketing"] });
    const [entry] = await storage.scheduler.list();
    clock.advance(86_400_000);
    const lift = () =>
      liftAnnounced({
        storage,
        ids,
        clock,
        logger,
        concurrencyRetries: 2,
        intentions,
        personId: "c-1",
        payload: entry?.command.payload as never,
        context: {
          correlationId: "c",
          causationId: "c",
          depth: 0,
          ...entry?.context,
          actor: "officer-1",
        },
      });
    expect(await lift()).toMatchObject({ eventTypes: ["ProcessingRestrictionLifted"] });
    expect(await storage.persons.restrictions("c-1")).toEqual([
      { ground: "legal-claims", category: "invoices", since: "2026-01-01T00:00:00.000Z" },
    ]);
    const [, , lifted] = await events(storage);
    expect(lifted).toMatchObject({
      payload: {
        grounds: ["legal-claims"],
        categories: ["marketing"],
        restrictions: [
          { ground: "legal-claims", categories: ["invoices"], since: "2026-01-01T00:00:00.000Z" },
        ],
      },
      metadata: { actor: "officer-1" },
    });
    expect(await lift()).toMatchObject({ eventIds: [] });
  });

  it("tells the log what it lifted or announced, and whether anything changed", async () => {
    const { clock, ids, logger, intentions, storage, logs, restrict, unrestrict } = await setup();
    await restrict("c-1", { ground: "legal-claims" });
    await unrestrict("c-1", { notice: "1d" });
    await unrestrict("c-1", { notice: "given", ground: "objection-pending" });
    const [entry] = await storage.scheduler.list();
    clock.advance(86_400_000);
    for (let run = 0; run < 2; run += 1) {
      await liftAnnounced({
        storage,
        ids,
        clock,
        logger,
        concurrencyRetries: 2,
        intentions,
        personId: "c-1",
        payload: entry?.command.payload as never,
        context: { correlationId: "c", causationId: "c", depth: 0, actor: "officer-1" },
      });
    }
    expect(logs.slice(1)).toEqual([
      {
        level: "info",
        message: "processing restriction lift announced",
        fields: { personId: "c-1", changed: true },
      },
      {
        level: "info",
        message: "processing restriction lifted",
        fields: { personId: "c-1", changed: false },
      },
      {
        level: "info",
        message: "processing restriction lifted",
        fields: { personId: "c-1", ground: "legal-claims", changed: true, actor: "officer-1" },
      },
      {
        level: "info",
        message: "processing restriction lifted",
        fields: { personId: "c-1", ground: "legal-claims", changed: false, actor: "officer-1" },
      },
    ]);
  });

  it("lifts every ground without one, and only its own with one", async () => {
    const { storage, restrict, unrestrict } = await setup();
    await restrict("c-1", { ground: "accuracy-contested" });
    await restrict("c-1", { ground: "objection-pending" });
    await unrestrict("c-1", { notice: "given", ground: "objection-pending" });
    expect((await storage.persons.restrictions("c-1")).map(({ ground }) => ground)).toEqual([
      "accuracy-contested",
    ]);
    await unrestrict("c-1", { notice: "given" });
    expect(await storage.persons.restrictions("c-1")).toEqual([]);
  });

  it("refuses categories of a person restricted as a whole on a ground it lifts, and a notice that is missing or not positive", async () => {
    const { storage, restrict, unrestrict } = await setup();
    await restrict("c-1", { ground: "objection-pending" });
    await restrict("c-1", { ground: "legal-claims", categories: ["invoices"] });
    await expect(
      unrestrict("c-1", { notice: "given", categories: ["invoices"] }),
    ).rejects.toMatchObject({
      message:
        'unrestrict names categories of a person restricted as a whole on "objection-pending"; lift that restriction as a whole',
      issues: [{ path: ["categories"], message: "Expected no categories for this ground" }],
    });
    await expect(
      unrestrict("c-1", { notice: "given", ground: "objection-pending", categories: ["invoices"] }),
    ).rejects.toThrow('restricted as a whole on "objection-pending"');
    await expect(
      unrestrict("c-1", { notice: undefined } as unknown as UnrestrictOptions),
    ).rejects.toMatchObject({
      issues: [
        {
          path: ["notice"],
          message: 'Expected a positive duration, or "given" for a person told already',
        },
      ],
    });
    expect(
      (
        await unrestrict("c-1", {
          notice: "given",
          ground: "legal-claims",
          categories: ["invoices"],
        })
      ).eventTypes,
    ).toEqual(["ProcessingRestrictionLifted"]);
    for (const notice of [undefined, 0, "0s", "-1d", "soon"]) {
      await expect(unrestrict("c-1", { notice } as unknown as UnrestrictOptions)).rejects.toThrow(
        'unrestrict needs a notice: a positive duration, or "given"',
      );
    }
    await expect(
      unrestrict("c-1", { notice: "given", ground: "because" } as unknown as UnrestrictOptions),
    ).rejects.toThrow("unrestrict needs a ground of article 18(1)");
    await expect(unrestrict("c-1", { notice: "given", categories: [] })).rejects.toThrow(
      "unrestrict needs at least one category when it names them",
    );
    expect(await storage.persons.restrictions("c-1")).toHaveLength(1);
  });

  it("lifts nothing for a person not restricted, known or not, nor what does not match", async () => {
    const { storage, restrict, unrestrict } = await setup();
    expect(await unrestrict("c-1")).toMatchObject({ version: 0, eventIds: [], position: 0 });
    expect(await storage.persons.get("c-1")).toBeNull();
    await restrict("c-1", { ground: "legal-claims", categories: ["invoices"] });
    expect(await unrestrict("c-1", { notice: "7d", categories: ["marketing"] })).toMatchObject({
      version: 1,
      eventIds: [],
    });
    expect(
      await unrestrict("c-1", { notice: "given", ground: "accuracy-contested" }),
    ).toMatchObject({ version: 1, eventIds: [] });
    await unrestrict("c-1");
    expect(await unrestrict("c-1")).toMatchObject({ version: 2, eventIds: [], position: 0 });
    expect(await storage.eventStore.lastPosition()).toBe(2);
    expect(await storage.scheduler.list()).toHaveLength(1);
  });

  it("calls off an announced lift with a restrict that adds nothing, appending it, and appends nothing once none is announced", async () => {
    const { storage, restrict, unrestrict } = await setup();
    await restrict("c-1", { ground: "legal-claims" });
    await unrestrict("c-1", { notice: "7d" });
    expect((await restrict("c-1", { ground: "legal-claims" })).eventTypes).toEqual([
      "ProcessingRestricted",
    ]);
    expect(await storage.scheduler.list()).toEqual([]);
    expect((await events(storage)).at(-1)?.payload).toMatchObject({
      restrictions: [{ ground: "legal-claims", categories: null }],
    });
    expect((await restrict("c-1", { ground: "legal-claims" })).eventTypes).toEqual([]);
    await unrestrict("c-1", { notice: "7d" });
    await unrestrict("c-1", { notice: "given" });
    expect((await restrict("c-1", { ground: "objection-pending" })).eventTypes).toEqual([
      "ProcessingRestricted",
    ]);
    expect((await restrict("c-1", { ground: "objection-pending" })).eventTypes).toEqual([]);
  });

  it("counts a lift pending only while it would lift something: one come due, lifted at once or of a category gone calls nothing off", async () => {
    const { storage, clock, ids, logger, intentions, restrict, unrestrict } = await setup();
    const due = async () => {
      clock.advance(86_400_000);
      for (const entry of await storage.scheduler.list()) {
        if (entry.command.type !== LIFT_RESTRICTION_COMMAND) continue;
        await liftAnnounced({
          storage,
          ids,
          clock,
          logger,
          concurrencyRetries: 2,
          intentions,
          personId: "c-1",
          payload: entry.command.payload as never,
          context: { correlationId: "c", causationId: "c", depth: 0 },
        });
        await storage.scheduler.cancel(entry.dedupeKey);
      }
    };
    const again = async () =>
      (await restrict("c-1", { ground: "legal-claims", categories: ["invoices"] })).eventTypes;
    await restrict("c-1", { ground: "legal-claims", categories: ["marketing", "invoices"] });
    await unrestrict("c-1", { notice: "1d", categories: ["marketing"] });
    await due();
    expect(await storage.persons.restrictions("c-1")).toEqual([
      expect.objectContaining({ ground: "legal-claims", category: "invoices" }),
    ]);
    expect(await again()).toEqual([]);
    await unrestrict("c-1", { notice: "1d", categories: ["invoices"] });
    await unrestrict("c-1", { notice: "given", categories: ["invoices"] });
    await restrict("c-1", { ground: "legal-claims", categories: ["invoices"] });
    expect(await again()).toEqual([]);
    await restrict("c-1", { ground: "legal-claims", categories: ["marketing"] });
    await unrestrict("c-1", { notice: "1d", categories: ["marketing"] });
    await unrestrict("c-1", { notice: "given", categories: ["marketing"] });
    expect(await again()).toEqual([]);
    await restrict("c-1", { ground: "legal-claims", categories: ["marketing"] });
    await unrestrict("c-1", { notice: "1d", ground: "legal-claims", categories: ["marketing"] });
    await unrestrict("c-1", { notice: "given", ground: "legal-claims", categories: ["marketing"] });
    await restrict("c-1", { ground: "objection-pending", categories: ["marketing"] });
    expect(await again()).toEqual([]);
    await unrestrict("c-1", { notice: "1d", ground: "legal-claims", categories: ["invoices"] });
    expect(await again()).toEqual(["ProcessingRestricted"]);
    await unrestrict("c-1", { notice: "1d", ground: "legal-claims" });
    expect(await again()).toEqual(["ProcessingRestricted"]);
    expect(await again()).toEqual([]);
  });

  it("keeps every lift announced on a ground, each lifting what it announced, and cancels them all on a restrict of the ground", async () => {
    const { storage, clock, ids, logger, intentions, restrict, unrestrict } = await setup();
    await restrict("c-1", { ground: "legal-claims", categories: ["marketing", "invoices"] });
    await unrestrict("c-1", { notice: "1d", categories: ["marketing"] });
    await unrestrict("c-1", { notice: "2d", categories: ["invoices"] });
    const lifts = await storage.scheduler.list();
    expect(lifts.map(({ dedupeKey }) => dedupeKey)).toEqual([
      liftRestrictionKey("c-1", "legal-claims", "marketing"),
      liftRestrictionKey("c-1", "legal-claims", "invoices"),
    ]);
    clock.advance(2 * 86_400_000);
    for (const entry of lifts) {
      await liftAnnounced({
        storage,
        ids,
        clock,
        logger,
        concurrencyRetries: 2,
        intentions,
        personId: "c-1",
        payload: entry.command.payload as never,
        context: { correlationId: "c", causationId: "c", depth: 0 },
      });
    }
    expect(await storage.persons.restrictions("c-1")).toEqual([]);
    await restrict("c-1", { ground: "legal-claims", categories: ["marketing", "invoices"] });
    await unrestrict("c-1", { notice: "1d", categories: ["marketing"] });
    await unrestrict("c-1", { notice: "1d" });
    expect(await storage.scheduler.list()).toHaveLength(3);
    await restrict("c-1", { ground: "legal-claims" });
    expect(
      (await storage.scheduler.list()).filter(({ dedupeKey }) =>
        dedupeKey.startsWith("lift-restriction:"),
      ),
    ).toEqual([]);
  });

  it("cancels a pending lift of a ground lifted at once in full, and keeps one whose ground is still restricted", async () => {
    const { storage, restrict, unrestrict } = await setup();
    await restrict("c-1", { ground: "legal-claims", categories: ["marketing", "invoices"] });
    await unrestrict("c-1", { notice: "7d", categories: ["marketing"] });
    await unrestrict("c-1", { notice: "given", categories: ["invoices"] });
    expect((await storage.scheduler.list()).map(({ dedupeKey }) => dedupeKey)).toEqual([
      "retry-restricted:c-1",
      liftRestrictionKey("c-1", "legal-claims", "marketing"),
    ]);
    await unrestrict("c-1", { notice: "given" });
    expect((await storage.scheduler.list()).map(({ dedupeKey }) => dedupeKey)).toEqual([
      "retry-restricted:c-1",
    ]);
  });
});

describe("refuseRestricted", () => {
  it("throws for a person restricted as a whole, unless a basis of article 18(2) opens it, and lets through nobody, an unknown person, a lifted one and one restricted in a category", async () => {
    const { storage, restrict, unrestrict } = await setup();
    const { persons } = storage;
    await restrict("c-1");
    await restrict("c-2");
    await unrestrict("c-2");
    await restrict("c-4", { ground: "legal-claims", categories: ["invoices"] });
    const refused = await refuseRestricted({ persons, person: "c-1" }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ProcessingRestrictedError);
    expect(refused).toMatchObject({
      code: "PROCESSING_RESTRICTED",
      personId: "c-1",
      message: "The processing of this person's data is restricted",
    });
    await expect(
      refuseRestricted({ persons, person: "c-1", basis: "legal-obligation" }),
    ).rejects.toBeInstanceOf(ProcessingRestrictedError);
    await expect(
      refuseRestricted({ persons, person: "c-1", basis: "consent" }),
    ).resolves.toBeUndefined();
    await expect(refuseRestricted({ persons, person: null })).resolves.toBeUndefined();
    await expect(refuseRestricted({ persons, person: "c-2" })).resolves.toBeUndefined();
    await expect(refuseRestricted({ persons, person: "c-3" })).resolves.toBeUndefined();
    await expect(refuseRestricted({ persons, person: "c-4" })).resolves.toBeUndefined();
    expect(restrictedPersonOf(refused)).toBe("c-1");
    expect(restrictedPersonOf(new Error("boom"))).toBeNull();
  });

  it("reads nothing for work that touches nobody, or that a basis of article 18(2) lets through", async () => {
    const persons: PersonStore = {
      get: vi.fn(),
      restrictions: vi.fn(),
      restrict: vi.fn(),
      unrestrict: vi.fn(),
      record: vi.fn(),
      listIdle: vi.fn(),
      hold: vi.fn(),
      nextHoldEnd: vi.fn(),
      countIdle: vi.fn(),
      releaseHolds: vi.fn(),
    };
    await refuseRestricted({ persons, person: null });
    await refuseRestricted({ persons, person: "c-1", basis: "public-interest" });
    expect(persons.restrictions).not.toHaveBeenCalled();
  });

  it("opens what a person asked to restrict only on a basis of article 18(2)", () => {
    expect(opensRequested(undefined)).toBe(false);
    expect(opensRequested("legal-obligation")).toBe(false);
    expect(opensRequested("consent")).toBe(true);
    expect(opensRequested("protection-of-rights")).toBe(true);
  });
});

describe("refuseRestrictedRead", () => {
  const keyOf = (category: string) => ({
    find: async () => ({
      category,
      key: { key: "k", fingerprint: "f-1", kid: null },
      retainedSince: null,
      lastActiveAt: null,
    }),
  });

  it("refuses what a forgetting kept unless a basis is named, and lets it through recorded with one", async () => {
    const { storage } = await setup();
    const kept = [{ person: "c-1", fingerprint: "f-1", retained: true as const }];
    await expect(
      refuseRestrictedRead({ persons: storage.persons, keys: keyOf("invoices"), opened: kept }),
    ).rejects.toMatchObject({ personId: "c-1" });
    expect(
      await refuseRestrictedRead({
        persons: storage.persons,
        keys: keyOf("invoices"),
        opened: kept,
        basis: "legal-obligation",
      }),
    ).toEqual(["c-1"]);
  });

  it("refuses data whose category a person restricted, or who as a whole, and a person touched while restricted as a whole", async () => {
    const { storage, restrict } = await setup();
    await restrict("c-1", { ground: "objection-pending", categories: ["marketing"] });
    await restrict("c-2", { ground: "objection-pending" });
    const opened = (person: string) => [{ person, fingerprint: "f-1" }];
    await expect(
      refuseRestrictedRead({
        persons: storage.persons,
        keys: keyOf("profile"),
        opened: opened("c-1"),
      }),
    ).resolves.toEqual([]);
    await expect(
      refuseRestrictedRead({
        persons: storage.persons,
        keys: keyOf("marketing"),
        opened: opened("c-1"),
      }),
    ).rejects.toMatchObject({ personId: "c-1" });
    await expect(
      refuseRestrictedRead({
        persons: storage.persons,
        keys: keyOf("profile"),
        opened: opened("c-2"),
      }),
    ).rejects.toMatchObject({ personId: "c-2" });
    await expect(
      refuseRestrictedRead({
        persons: storage.persons,
        keys: keyOf("profile"),
        opened: [],
        touches: ["c-2", "c-1"],
      }),
    ).rejects.toMatchObject({ personId: "c-2" });
    await expect(
      refuseRestrictedRead({
        persons: storage.persons,
        keys: keyOf("marketing"),
        opened: [...opened("c-1"), { person: "c-3", fingerprint: null }],
        touches: ["c-2"],
        basis: "consent",
      }),
    ).resolves.toEqual(["c-2", "c-1"]);
    await expect(
      refuseRestrictedRead({
        persons: storage.persons,
        keys: keyOf("marketing"),
        opened: opened("c-1"),
        basis: "legal-obligation",
      }),
    ).rejects.toMatchObject({ personId: "c-1" });
  });

  it("refuses data of a person restricted as a whole though its key is gone, and passes over what was opened with no key", async () => {
    const { storage, restrict } = await setup();
    await restrict("c-1", { ground: "objection-pending" });
    const gone = { find: async () => null };
    await expect(
      refuseRestrictedRead({
        persons: storage.persons,
        keys: gone,
        opened: [{ person: "c-1", fingerprint: "f-1" }],
      }),
    ).rejects.toMatchObject({ personId: "c-1" });
    await expect(
      refuseRestrictedRead({
        persons: storage.persons,
        keys: gone,
        opened: [{ person: "c-1", fingerprint: null }],
      }),
    ).resolves.toEqual([]);
  });

  it("lets through a key gone since, whose category it cannot tell", async () => {
    const { storage, restrict } = await setup();
    await restrict("c-1", { ground: "objection-pending", categories: ["marketing"] });
    await expect(
      refuseRestrictedRead({
        persons: storage.persons,
        keys: { find: async () => null },
        opened: [{ person: "c-1", fingerprint: "f-1" }],
      }),
    ).resolves.toEqual([]);
  });
});

describe("restrictAgain", () => {
  const T1 = "2026-01-01T00:00:00.000Z";
  const T2 = "2026-01-02T00:00:00.000Z";
  const again = async (storage: Storage, entry: Parameters<typeof restrictAgain>[0]["entry"]) =>
    restrictAgain({
      storage,
      ids: createSequentialIdGenerator(),
      clock: createFixedClock(),
      concurrencyRetries: 1,
      entry,
    });
  const restrictedEntry = (eventId: string, at: string) => ({
    personId: "c-1",
    eventId,
    forgottenAt: at,
    categories: null,
    reason: "requested" as const,
    restriction: {
      type: "ProcessingRestricted" as const,
      payload: {
        personId: "c-1",
        ground: "legal-claims" as const,
        categories: null,
        restrictions: [{ ground: "legal-claims" as const, categories: null, since: at }],
      },
    },
  });

  it("commits a restriction the store lost, cancelling a lift announced on its ground, and nothing once it holds it", async () => {
    const storage = await memory().createStorage();
    await storage.scheduler.schedule({
      dedupeKey: liftRestrictionKey("c-1", "legal-claims", null),
      command: { type: LIFT_RESTRICTION_COMMAND, aggregateId: "c-1", payload: {} },
      executeAt: new Date(T2),
      context: { correlationId: "c", causationId: "c", depth: 0 },
    });
    const event = await again(storage, restrictedEntry("e-1", T1));
    expect(event).toMatchObject({ id: "e-1", timestamp: T1, type: "ProcessingRestricted" });
    expect(await storage.persons.restrictions("c-1")).toEqual([
      { ground: "legal-claims", category: null, since: T1 },
    ]);
    expect(await storage.scheduler.list()).toEqual([]);
    expect(await again(storage, restrictedEntry("e-1", T1))).toBeNull();
    expect(await storage.eventStore.lastPosition()).toBe(1);
  });

  it("commits nothing a later change superseded, nor what the store already holds", async () => {
    const storage = await memory().createStorage();
    await again(storage, restrictedEntry("e-2", T2));
    expect(await again(storage, restrictedEntry("e-1", T1))).toBeNull();
    expect(await again(storage, restrictedEntry("e-0", T2))).toBeNull();
    const earlier = restrictedEntry("e-1", T2);
    expect(
      await again(storage, {
        ...earlier,
        restriction: {
          ...earlier.restriction,
          payload: {
            ...earlier.restriction.payload,
            restrictions: [{ ground: "legal-claims", categories: ["invoices"], since: T2 }],
          },
        },
      }),
    ).toBeNull();
    const held = restrictedEntry("e-3", "2026-01-03T00:00:00.000Z");
    expect(
      await again(storage, {
        ...held,
        restriction: {
          ...held.restriction,
          payload: {
            ...held.restriction.payload,
            restrictions: [{ ground: "legal-claims", categories: null, since: T2 }],
          },
        },
      }),
    ).toBeNull();
    expect(await storage.eventStore.lastPosition()).toBe(1);
  });

  it("commits a lift again, its rows gone and the retry of the person's letters scheduled, and an announcement with its lifts", async () => {
    const storage = await memory().createStorage();
    await again(storage, restrictedEntry("e-1", T1));
    const lifted = await again(storage, {
      personId: "c-1",
      eventId: "e-2",
      forgottenAt: T2,
      categories: null,
      reason: "requested",
      restriction: {
        type: "ProcessingRestrictionLifted",
        payload: { personId: "c-1", grounds: ["legal-claims"], categories: null, restrictions: [] },
      },
    });
    expect(lifted?.type).toBe("ProcessingRestrictionLifted");
    expect(await storage.persons.restrictions("c-1")).toEqual([]);
    expect((await storage.scheduler.list()).map(({ dedupeKey }) => dedupeKey)).toEqual([
      "retry-restricted:c-1",
    ]);
    const announced = await again(storage, {
      personId: "c-1",
      eventId: "e-3",
      forgottenAt: "2026-01-03T00:00:00.000Z",
      categories: null,
      reason: "requested",
      restriction: {
        type: "ProcessingRestrictionLiftAnnounced",
        payload: {
          personId: "c-1",
          grounds: ["legal-claims"],
          categories: null,
          liftsAt: "2026-01-10T00:00:00.000Z",
        },
      },
    });
    expect(announced?.type).toBe("ProcessingRestrictionLiftAnnounced");
    expect(await storage.scheduler.list()).toContainEqual(
      expect.objectContaining({
        dedupeKey: liftRestrictionKey("c-1", "legal-claims", null),
        executeAt: "2026-01-10T00:00:00.000Z",
      }),
    );
  });
});
