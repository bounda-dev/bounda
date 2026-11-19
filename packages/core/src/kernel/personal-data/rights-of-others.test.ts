import { describe, expect, it } from "vitest";
import type { Table } from "../../adapter/storage/table.ts";
import type { RejectedDispatch } from "../../contracts/command.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { PersonalDataAccess } from "../../modules/audit.ts";
import type { RejectFunction } from "../../modules/command.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { createTestApp } from "../../testing/index.ts";

interface MemberState {
  readonly name: string | null;
}

interface MemberRow {
  readonly memberId: string;
  readonly name: string | null;
}

type Dispatch = (payload: unknown, options?: unknown) => Promise<unknown>;

// Whether the projection of a referral fails, as it does until a fix ships.
let listing = { fails: true };

// One error the policy throws every time it gives up, when set, as code that keeps one instance.
let givingUp: { shared: Error | null } = { shared: null };

// A member refers another: the policy thanks the one referred, whose state refuses it, quoting their
// name, and gives up quoting the refusal; the projection fails quoting the row of the one referred.
const registry = {
  aggregates: {
    member: {
      state: { initialState: { name: null } satisfies MemberState },
      events: {
        memberJoined: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ name: personal(z.string()) }),
          evolve: ({ event }: { event: { payload: { name: string | null } } }) => ({
            name: event.payload.name,
          }),
        },
        memberReferred: {
          payload: ({ z, notPersonal, personal }: EventPayloadArgs) =>
            z.object({ referredId: notPersonal(z.string()), note: personal(z.string()) }),
          evolve: ({ state }: { state: MemberState }) => state,
        },
      },
      commands: {
        joinMember: {
          module: {
            payload: ({ z, notPersonal, personal }: CommandPayloadArgs) =>
              z.object({ memberId: notPersonal(z.string()), name: personal(z.string()) }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { name: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.memberJoined?.({ name: command.payload.name })],
          },
        },
        referMember: {
          module: {
            payload: ({ z, notPersonal, personal }: CommandPayloadArgs) =>
              z.object({
                memberId: notPersonal(z.string()),
                referredId: notPersonal(z.string()),
                note: personal(z.string()),
              }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { referredId: string; note: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.memberReferred?.(command.payload)],
          },
        },
        thankMember: {
          module: {
            payload: ({ z, notPersonal, person }: CommandPayloadArgs) =>
              z.object({ memberId: notPersonal(z.string()), by: person(z.string()) }),
            rejections: ({ state }: { state: MemberState }) => ({
              Unthankable: `${state.name ?? "Nobody"} takes no thanks`,
            }),
            handler: ({ reject }: { reject: RejectFunction<"Unthankable"> }) =>
              reject("Unthankable"),
          },
        },
      },
      policies: {
        thankOnMemberReferred: {
          module: {
            handler: async ({
              event,
              commands,
            }: {
              event: { aggregateId: string; payload: { referredId: string } };
              commands: Record<string, Dispatch>;
            }) => {
              const thanked = (await commands.thankMember?.({
                memberId: event.payload.referredId,
                by: event.aggregateId,
              })) as RejectedDispatch;
              throw givingUp.shared ?? new ValidationError(`gave up: ${thanked.message}`, []);
            },
          },
        },
      },
      processes: {},
    },
  },
  readModels: {
    members: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          memberId: f.string().primaryKey().person(),
          name: f.string().optional().personal(),
        }),
      },
      projections: {
        member: {
          memberJoined: {
            project: ({
              event,
              table,
            }: {
              event: StoredEvent<"MemberJoined", { name: string | null }>;
              table: Table<MemberRow>;
            }) => table.upsert({ memberId: event.aggregateId, name: event.payload.name }),
          },
          memberReferred: {
            project: async ({
              event,
              table,
            }: {
              event: StoredEvent<"MemberReferred", { referredId: string }>;
              table: Table<MemberRow>;
            }) => {
              const referred = await table.findOne({ memberId: event.payload.referredId });
              if (listing.fails) {
                throw new ValidationError(`cannot list ${referred?.name ?? "nobody"}`, []);
              }
            },
          },
        },
      },
      queries: {},
    },
  },
} as unknown as Registry;

const FOR_OTHERS = { reason: "rights-of-others", article: "15(4)" } as const;

const setup = async () => {
  listing = { fails: true };
  givingUp = { shared: null };
  const adapter = memory();
  const storage = await adapter.createStorage();
  const accesses: PersonalDataAccess[] = [];
  const { app } = await createTestApp({
    registry,
    onPersonalDataAccess: ({ access }) => {
      accesses.push(access);
    },
    adapter,
    logger: silentLogger,
    config: { runtime: { policies: { retry: { strategy: "none" } } } },
  });
  const commands = app.commands as unknown as Readonly<Record<string, Dispatch>>;
  await commands.joinMember?.({ memberId: "ana", name: "Ana" });
  await commands.joinMember?.({ memberId: "bea", name: "Bea Sanz" });
  await app.runUntilIdle();
  return { app, storage, commands, accesses };
};

const referred = async () => {
  const context = await setup();
  await context.commands.referMember?.({ memberId: "ana", referredId: "bea", note: "a friend" });
  await context.app.runUntilIdle();
  const [letter] = await context.storage.deadLetterStore.list({ kind: "policy" });
  if (letter === undefined) throw new Error("the policy did not give up");
  return { ...context, letter };
};

describe("text the work wrote while it read data of someone else", () => {
  it("is sealed under them too, and names them on the dead letter and in the access log", async () => {
    const { app, letter, storage, accesses } = await referred();
    expect(letter).toMatchObject({ person: "ana", readPersons: ["bea"] });
    expect(JSON.stringify(letter)).not.toContain("Bea Sanz");
    expect(
      JSON.stringify(await storage.subscriberFailures.get("projection:members")),
    ).not.toContain("Bea Sanz");
    accesses.length = 0;
    expect(await app.deadLetters.get(letter.id)).toMatchObject({
      errorMessage: "gave up: Bea Sanz takes no thanks",
    });
    expect(await app.subscriberFailures.get("projection:members")).toMatchObject({
      errorMessage: "cannot list Bea Sanz",
    });
    expect(accesses.map(({ operation, persons }) => [operation, persons])).toEqual([
      ["deadLetters.get", ["ana", "bea"]],
      ["subscriberFailures.get", ["ana", "bea"]],
    ]);
    await app.stop();
  });

  it("thrown as one instance by two runs, is sealed under whom either read, since its text may quote either", async () => {
    const { app, storage, commands } = await setup();
    givingUp = { shared: new ValidationError("gave up", []) };
    await commands.joinMember?.({ memberId: "cai", name: "Cai" });
    await commands.referMember?.({ memberId: "ana", referredId: "bea", note: "a friend" });
    await app.runUntilIdle();
    const [first] = await storage.deadLetterStore.list({ kind: "policy" });
    expect(first).toMatchObject({ readPersons: ["bea"] });
    await commands.referMember?.({ memberId: "ana", referredId: "cai", note: "another" });
    await app.runUntilIdle();
    const second = (await storage.deadLetterStore.list({ kind: "policy" })).find(
      ({ id }) => id !== first?.id,
    );
    expect(second).toMatchObject({ readPersons: ["bea", "cai"] });
    await app.stop();
  });

  it("is held back from the export of each of them, and opened, still marked, with includeWithheld", async () => {
    const { app, letter, accesses } = await referred();
    const withheld = [
      { field: "errorMessage", ...FOR_OTHERS },
      { field: "errorStack", ...FOR_OTHERS },
    ];
    for (const person of ["ana", "bea"]) {
      const exported = await app.exportPersonalData(person);
      expect(exported.deadLetters).toEqual([
        expect.objectContaining({ id: letter.id, errorMessage: null, errorStack: null, withheld }),
      ]);
      expect(JSON.stringify(exported)).not.toContain("takes no thanks");
    }
    accesses.length = 0;
    const opened = await app.exportPersonalData("ana", { includeWithheld: true });
    expect(opened.deadLetters).toEqual([
      expect.objectContaining({ errorMessage: "gave up: Bea Sanz takes no thanks", withheld }),
    ]);
    expect(accesses.map(({ outcome, persons }) => [outcome, persons])).toEqual([
      ["started", ["ana"]],
      ["ok", ["ana", "bea"]],
    ]);
    expect(accesses.at(-1)).toMatchObject({
      detail: { deadLetters: 1, subscriberFailures: 1, withheld: 2, includeWithheld: true },
    });
    await app.stop();
  });

  it("withheld, never tells the person that someone else it quotes is restricted", async () => {
    const { app, letter } = await referred();
    await app.restrict("bea", { ground: "accuracy-contested" });
    const exported = await app.exportPersonalData("ana");
    expect(exported.deadLetters).toEqual([
      expect.objectContaining({ id: letter.id, errorMessage: null, restricted: [] }),
    ]);
    expect(exported.subscriberFailures).toEqual([
      expect.objectContaining({ errorMessage: null, restricted: [] }),
    ]);
    const opened = await app.exportPersonalData("ana", { includeWithheld: true });
    expect(opened.deadLetters).toEqual([
      expect.objectContaining({ restricted: ["errorMessage", "errorStack"] }),
    ]);
    await app.restrict("ana", { ground: "accuracy-contested" });
    expect((await app.exportPersonalData("ana")).deadLetters).toEqual([
      expect.objectContaining({ errorMessage: null, restricted: ["errorMessage", "errorStack"] }),
    ]);
    await app.stop();
  });

  it("reads null once any of them is forgotten, and stays sealed while any of them is restricted", async () => {
    const { app, letter } = await referred();
    await app.restrict("bea", { ground: "accuracy-contested" });
    expect(await app.deadLetters.get(letter.id)).toMatchObject({
      errorMessage: null,
      restricted: true,
    });
    await app.unrestrict("bea", { notice: "given" });
    await app.forget("bea");
    expect(await app.deadLetters.get(letter.id)).toMatchObject({ errorMessage: null });
    expect(await app.deadLetters.get(letter.id)).not.toHaveProperty("restricted");
    await app.stop();
  });

  it("of a projection, about the rows it read, is held back from each of them", async () => {
    const { app, storage } = await referred();
    const failure = await storage.subscriberFailures.get("projection:members");
    expect(failure).toMatchObject({ person: "ana", readPersons: ["bea"] });
    for (const person of ["ana", "bea"]) {
      expect((await app.exportPersonalData(person)).subscriberFailures).toEqual([
        expect.objectContaining({
          subscriber: "projection:members",
          errorMessage: null,
          withheld: [
            { field: "errorMessage", ...FOR_OTHERS },
            { field: "errorStack", ...FOR_OTHERS },
          ],
        }),
      ]);
    }
    expect(
      (await app.exportPersonalData("bea", { includeWithheld: true })).subscriberFailures,
    ).toEqual([expect.objectContaining({ errorMessage: "cannot list Bea Sanz" })]);
    await app.restrict("bea", { ground: "accuracy-contested" });
    expect(await app.subscriberFailures.get("projection:members")).toMatchObject({
      errorMessage: null,
      restricted: true,
    });
    await app.stop();
  });

  it("quoting a value of theirs a redaction seals is sealed for good, still naming them", async () => {
    const { app, storage, letter } = await referred();
    // Kept in the clear, by work whose event named nobody and that read nothing under a key.
    await storage.subscriberFailures.record({
      subscriber: "projection:copies",
      position: 1,
      eventId: "e-1",
      eventType: "MemberReferred",
      person: null,
      errorName: "Error",
      errorMessage: "copied Bea Sanz",
      failedAt: "2026-01-01T00:00:00.000Z",
    });
    const joined = (await app.exportPersonalData("bea")).events.filter(
      ({ type }) => type === "MemberJoined",
    );
    await app.redact("bea", {
      events: joined.map(({ aggregateType, aggregateId, type, id }) => ({
        aggregateType,
        aggregateId,
        type,
        id,
        fields: ["name"],
      })),
    } as never);
    listing.fails = false;
    await app.runUntilIdle();
    expect(await storage.deadLetterStore.get(letter.id)).toMatchObject({ readPersons: ["bea"] });
    expect(await app.deadLetters.get(letter.id)).toMatchObject({ errorMessage: null });
    expect(await app.subscriberFailures.get("projection:members")).toMatchObject({
      errorMessage: null,
    });
    expect(await app.subscriberFailures.get("projection:copies")).toMatchObject({
      errorMessage: null,
    });
    await app.stop();
  });

  it("of a projection, about a row whose person is forgotten, names nobody for it", async () => {
    const { app, storage, commands } = await setup();
    await app.forget("bea");
    await commands.referMember?.({ memberId: "ana", referredId: "bea", note: "a friend" });
    await app.runUntilIdle();
    const failure = await storage.subscriberFailures.get("projection:members");
    expect(failure).toMatchObject({ person: "ana" });
    expect(failure).not.toHaveProperty("readPersons");
    expect(await app.subscriberFailures.get("projection:members")).toMatchObject({
      errorMessage: "cannot list nobody",
    });
    await app.stop();
  });

  it("of a remembered rejection, decided on another person's state, is held back from each", async () => {
    const { app, commands } = await setup();
    await expect(
      commands.thankMember?.({ memberId: "bea", by: "ana" }, { idempotencyKey: "thanks-1" }),
    ).rejects.toMatchObject({ rejected: "Unthankable" });
    for (const person of ["ana", "bea"]) {
      const exported = await app.exportPersonalData(person);
      expect(exported.answers).toEqual([
        {
          idempotencyKey: null,
          expiresAt: expect.any(String),
          outcome: null,
          restricted: [],
          withheld: [
            { field: "idempotencyKey", ...FOR_OTHERS },
            { field: "outcome", ...FOR_OTHERS },
          ],
        },
      ]);
      expect(JSON.stringify(exported)).not.toContain("takes no thanks");
    }
    expect((await app.exportPersonalData("bea", { includeWithheld: true })).answers).toEqual([
      expect.objectContaining({
        idempotencyKey: "thanks-1",
        outcome: expect.objectContaining({ message: "Bea Sanz takes no thanks" }),
      }),
    ]);
    await app.stop();
  });
});
