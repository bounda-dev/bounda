import { describe, expect, it } from "vitest";
import type { ReadClient, Table } from "../../adapter/storage/table.ts";
import { ProcessingRestrictedError, ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { PersonalDataAccess } from "../../modules/audit.ts";
import type { RejectFunction } from "../../modules/command.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { createTestApp } from "../../testing/index.ts";

interface Person {
  readonly personId: string;
  readonly name: string;
}

interface Directory {
  lookup(personId: string): Promise<Person>;
}

type Lookup = (personId: string) => Promise<Person>;

type Dispatch = (payload: unknown, options?: unknown) => Promise<unknown>;

type Events = Record<string, (payload?: unknown) => unknown>;

// What the directory, a system outside the app, holds: zoe is no member.
const PEOPLE: Readonly<Record<string, string>> = {
  bea: "Bea Sanz",
  zoe: "Zoe Ruiz",
};

const directory: Directory = {
  lookup: async (personId) => {
    const name = PEOPLE[personId];
    if (name === undefined) throw new ValidationError(`${personId} is unknown`, []);
    return { personId, name };
  },
};

const lookup: Lookup = (personId) => directory.lookup(personId);

interface Notifier {
  send(text: string): Promise<void>;
  confirm(personId: string): Promise<Person>;
}

const notifier: Notifier = {
  send: async () => undefined,
  confirm: (personId) => directory.lookup(personId),
};

const silent = async () => undefined;

const notifierModule = {
  recipient: { name: "Postmark", kind: "processor", country: "IE", categories: ["default"] },
  // Fails quoting what the notifier answered, once a test asks it to.
  onPersonalDataForgotten: async ({ notifier: told }: { notifier: Notifier }) => {
    if (!confirming) return;
    throw new ValidationError(`could not tell ${(await told.confirm("zoe")).name}`, []);
  },
  onProcessingRestricted: silent,
  onProcessingRestrictionLiftAnnounced: silent,
  onProcessingRestrictionLifted: silent,
  onPersonalDataRedacted: silent,
  onTenantForgotten: silent,
};

// Whether the policy that introduces a friend tells the notifier.
let introducing = false;

// Whether the notifier's handler of a forgetting fails.
let confirming = false;

// What the reactions that only some tests run do: check the friend through a command, read them
// on a basis, fail the process quoting them.
let reacting = { checking: false, onBasis: false, failingProcess: false };

// What the projection of a vouch reads through the driver, by whose row: as `rawReadOf` is told.
let rawReads: string[] = [];

// A member vouches for a friend: the command asks the directory and turns down one who is a
// member's own name; the policy greets the friend and gives up quoting the directory; the
// projection reads the friend's row raw and fails quoting it. A query looks a person up.
const registry = {
  aggregates: {
    member: {
      state: { initialState: {} },
      events: {
        memberJoined: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ name: personal(z.string()) }),
          evolve: ({ event }: { event: { payload: object } }) => ({ ...event.payload }),
        },
        memberVouched: {
          payload: ({ z, notPersonal, personal }: EventPayloadArgs) =>
            z.object({ friendId: notPersonal(z.string()), note: personal(z.string()) }),
          evolve: ({ state }: { state: object }) => state,
        },
      },
      ports: {
        directory: { memory: { default: directory } },
        notifier: { memory: { default: notifier } },
      },
      recipients: { notifier: notifierModule },
      returns: {
        notifier: {
          returnsPersonalData: {
            confirm: { persons: ({ result }: { result: Person }) => result.personId },
            send: false,
          },
        },
        directory: {
          returnsPersonalData: {
            lookup: {
              persons: ({ result }: { result: Person }) => result.personId,
              personsOnError: ({ args: [personId] }: { args: [string] }) => personId,
            },
          },
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
              events: Events;
            }) => [events.memberJoined?.({ name: command.payload.name })],
          },
        },
        checkFriend: {
          module: {
            payload: ({ z, notPersonal, person }: CommandPayloadArgs) =>
              z.object({ memberId: person(z.string()), friendId: notPersonal(z.string()) }),
            handler: async ({
              command,
              directory: port,
            }: {
              command: { payload: { friendId: string } };
              directory: Directory;
            }) => {
              const friend = await port.lookup(command.payload.friendId);
              throw new ValidationError(`cannot check ${friend.name}`, []);
            },
          },
        },
        vouchFor: {
          module: {
            payload: ({ z, notPersonal, person }: CommandPayloadArgs) =>
              z.object({ memberId: person(z.string()), friendId: notPersonal(z.string()) }),
            rejections: () => ({ Stranger: "a stranger" }),
            handler: async ({
              command,
              events,
              reject,
              directory: port,
            }: {
              command: { payload: { friendId: string } };
              events: Events;
              reject: RejectFunction<"Stranger">;
              directory: Directory;
            }) => {
              const friend = await port.lookup(command.payload.friendId);
              if (friend.personId === "zoe")
                return reject("Stranger", `${friend.name} is a stranger`);
              return [events.memberVouched?.({ friendId: friend.personId, note: "a friend" })];
            },
          },
        },
      },
      policies: {
        // Checks the friend through a command, whose handler fails quoting them.
        checkOnMemberVouched: {
          module: {
            handler: async ({
              event,
              commands,
            }: {
              event: { aggregateId: string; payload: { friendId: string } };
              commands: Record<string, Dispatch>;
            }) => {
              if (!reacting.checking) return;
              await commands.checkFriend?.({
                memberId: event.aggregateId,
                friendId: event.payload.friendId,
              });
            },
          },
        },
        // Reads the friend on a basis that opens a restriction.
        recallOnMemberVouched: {
          module: {
            restricted: "legal-claims",
            handler: async ({
              event,
              directory: port,
            }: {
              event: { payload: { friendId: string } };
              directory: Directory;
            }) => {
              if (reacting.onBasis) await port.lookup(event.payload.friendId);
            },
          },
        },
        // Tells the notifier the friend's name it read from the directory.
        introduceOnMemberVouched: {
          module: {
            handler: async ({
              event,
              directory: port,
              notifier: told,
            }: {
              event: { payload: { friendId: string } };
              directory: Directory;
              notifier: Notifier;
            }) => {
              if (!introducing) return;
              await told.send((await port.lookup(event.payload.friendId)).name);
            },
          },
        },
        greetOnMemberVouched: {
          module: {
            handler: async ({
              event,
              directory: port,
            }: {
              event: { payload: { friendId: string } };
              directory: Directory;
            }) => {
              const friend = await port.lookup(event.payload.friendId);
              throw new ValidationError(`cannot greet ${friend.name}`, []);
            },
          },
        },
      },
      processes: {
        // Reads the friend on a basis that opens a restriction.
        welcome: {
          module: {
            config: ({ events }: { events: { member: Record<string, unknown> } }) => ({
              startedBy: [events.member.MemberVouched],
              timeout: "30d",
            }),
            restricted: "legal-claims",
          },
          handlers: {
            member: {
              memberVouched: {
                handler: async ({
                  event,
                  directory: port,
                }: {
                  event: { payload: { friendId: string } };
                  directory: Directory;
                }) => {
                  const friend = await port.lookup(event.payload.friendId);
                  if (reacting.failingProcess) {
                    throw new ValidationError(`cannot welcome ${friend.name}`, []);
                  }
                  return {};
                },
              },
            },
          },
          deadlines: {},
        },
      },
    },
  },
  readModels: {
    people: {
      view: {
        fields: ({ f }: FieldsArgs) => ({ id: f.string().primaryKey().notPersonal() }),
      },
      ports: {
        lookup: { memory: { default: lookup } },
        audience: { memory: { default: notifier } },
      },
      recipients: { audience: notifierModule },
      returns: {
        lookup: {
          returnsPersonalData: { persons: ({ result }: { result: Person }) => result.personId },
        },
      },
      projections: {},
      queries: {
        find: {
          payload: ({ z }: { z: typeof import("zod").z }) => z.object({ personId: z.string() }),
          handler: ({
            query,
            lookup: port,
          }: {
            query: { payload: { personId: string } };
            lookup: Lookup;
          }) => port(query.payload.personId),
        },
        rawFind: {
          payload: ({ z }: { z: typeof import("zod").z }) =>
            z.object({ personId: z.string(), named: z.boolean().optional() }),
          repository: async ({
            personId,
            named,
            client,
          }: {
            personId: string;
            named?: boolean;
            client: ReadClient<Record<string, unknown>>;
          }) => {
            await client.rawReadOf(
              personId,
              named === undefined
                ? { categories: ["contacts" as "default"] }
                : named
                  ? { categories: ["default"] }
                  : undefined,
            );
            return personId;
          },
          handler: ({ repositoryData }: { repositoryData: string }) => repositoryData,
        },
        share: {
          payload: ({ z }: { z: typeof import("zod").z }) => z.object({ personId: z.string() }),
          handler: async ({
            query,
            lookup: port,
            audience,
          }: {
            query: { payload: { personId: string } };
            lookup: Lookup;
            audience: Notifier;
          }) => {
            await audience.send((await port(query.payload.personId)).name);
            return null;
          },
        },
        rawNobody: {
          payload: ({ z }: { z: typeof import("zod").z }) => z.object({}),
          repository: async ({ client }: { client: ReadClient<Record<string, unknown>> }) => {
            await client.rawReadOf([null, undefined], { categories: ["default"] });
            return null;
          },
          handler: () => null,
        },
        nobody: {
          payload: ({ z }: { z: typeof import("zod").z }) => z.object({}),
          handler: () => null,
        },
      },
    },
    members: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          memberId: f.string().primaryKey().person(),
          name: f.string().optional().personal(),
        }),
      },
      ports: { lookup: { memory: { default: lookup } } },
      returns: {
        lookup: {
          returnsPersonalData: { persons: ({ result }: { result: Person }) => result.personId },
        },
      },
      projections: {
        member: {
          memberJoined: {
            project: ({
              event,
              table,
            }: {
              event: StoredEvent<"MemberJoined", { name: string }>;
              table: Table<{ memberId: string; name: string | null }>;
            }) => table.upsert({ memberId: event.aggregateId, name: event.payload.name }),
          },
          memberVouched: {
            project: async ({
              event,
              client,
            }: {
              event: StoredEvent<"MemberVouched", { friendId: string }>;
              client: ReadClient<Record<string, unknown>>;
            }) => {
              rawReads.push(event.payload.friendId);
              await client.rawReadOf(event.payload.friendId);
              throw new ValidationError(`cannot list ${PEOPLE[event.payload.friendId]}`, []);
            },
          },
        },
      },
      queries: {
        whoIs: {
          payload: ({ z }: { z: typeof import("zod").z }) => z.object({ personId: z.string() }),
          handler: ({
            query,
            lookup: port,
          }: {
            query: { payload: { personId: string } };
            lookup: Lookup;
          }) => port(query.payload.personId),
        },
        rawWhoIs: {
          payload: ({ z }: { z: typeof import("zod").z }) => z.object({ personId: z.string() }),
          repository: async ({
            personId,
            client,
          }: {
            personId: string;
            client: ReadClient<Record<string, unknown>>;
          }) => {
            await client.rawReadOf([personId, null]);
            return personId;
          },
          handler: ({ repositoryData }: { repositoryData: string }) => repositoryData,
        },
      },
    },
  },
} as unknown as Registry;

const FOR_OTHERS = { reason: "rights-of-others", article: "15(4)" } as const;

const setup = async () => {
  rawReads = [];
  introducing = false;
  confirming = false;
  reacting = { checking: false, onBasis: false, failingProcess: false };
  const adapter = memory();
  const storage = await adapter.createStorage();
  const accesses: PersonalDataAccess[] = [];
  const { app } = await createTestApp({
    registry,
    onPersonalDataAccess: ({ access }) => {
      accesses.push(access);
    },
    adapter,
    ports: {
      member: { directory: "memory", notifier: "memory" },
      members: { lookup: "memory" },
      people: { lookup: "memory", audience: "memory" },
    } as never,
    logger: silentLogger,
    config: { runtime: { policies: { retry: { strategy: "none" } } } },
  });
  const commands = app.commands as unknown as Readonly<Record<string, Dispatch>>;
  const queries = app.queries as unknown as Readonly<Record<string, Dispatch>>;
  await commands.joinMember?.({ memberId: "ana", name: "Ana" });
  await commands.joinMember?.({ memberId: "bea", name: "Bea Sanz" });
  await app.runUntilIdle();
  return { app, storage, commands, queries, accesses };
};

const vouched = async () => {
  const context = await setup();
  await context.commands.vouchFor?.({ memberId: "ana", friendId: "bea" });
  await context.app.runUntilIdle();
  const [letter] = await context.storage.deadLetterStore.list({ kind: "policy" });
  if (letter === undefined) throw new Error("the policy did not give up");
  return { ...context, letter };
};

describe("text built from what a port returned", () => {
  it("is sealed under whom the port said its answer holds data of, and held back from others", async () => {
    const { app, letter } = await vouched();
    expect(letter).toMatchObject({ person: "ana", readPersons: ["bea"] });
    expect(JSON.stringify(letter)).not.toContain("Bea Sanz");
    expect(await app.deadLetters.get(letter.id)).toMatchObject({
      errorMessage: "cannot greet Bea Sanz",
    });
    for (const person of ["ana", "bea"]) {
      expect((await app.exportPersonalData(person)).deadLetters).toEqual([
        expect.objectContaining({
          id: letter.id,
          errorMessage: null,
          withheld: [
            { field: "errorMessage", ...FOR_OTHERS },
            { field: "errorStack", ...FOR_OTHERS },
          ],
        }),
      ]);
    }
    await app.forget("bea");
    expect(await app.deadLetters.get(letter.id)).toMatchObject({ errorMessage: null });
    await app.stop();
  });

  it("keys a person the app held nothing of, so their forgetting reaches it", async () => {
    const { app, commands } = await setup();
    await expect(
      commands.vouchFor?.({ memberId: "ana", friendId: "zoe" }, { idempotencyKey: "vouch-1" }),
    ).rejects.toMatchObject({ rejected: "Stranger" });
    const answers = (await app.exportPersonalData("zoe")).answers;
    expect(answers).toEqual([
      expect.objectContaining({
        outcome: null,
        withheld: [
          { field: "idempotencyKey", ...FOR_OTHERS },
          { field: "outcome", ...FOR_OTHERS },
        ],
      }),
    ]);
    expect((await app.exportPersonalData("ana", { includeWithheld: true })).answers).toEqual([
      expect.objectContaining({
        outcome: expect.objectContaining({ message: "Zoe Ruiz is a stranger" }),
      }),
    ]);
    await app.forget("zoe");
    expect((await app.exportPersonalData("ana", { includeWithheld: true })).answers).toEqual([]);
    await app.stop();
  });

  it("of a call that failed, is sealed under whom personsOnError names", async () => {
    const { app, storage, commands } = await setup();
    await commands.joinMember?.({ memberId: "cai", name: "Cai" });
    await commands.vouchFor?.({ memberId: "cai", friendId: "bea" });
    await app.runUntilIdle();
    const letters = await storage.deadLetterStore.list({ kind: "policy" });
    expect(letters.map(({ readPersons }) => readPersons)).toEqual([["bea"]]);
    await expect(commands.vouchFor?.({ memberId: "ana", friendId: "yan" })).rejects.toThrow(
      "yan is unknown",
    );
    await app.stop();
  });

  it("refuses the data of a restricted person unless the run names a basis, and logs it then", async () => {
    const { app, commands, accesses } = await setup();
    await app.restrict("zoe", { ground: "accuracy-contested" });
    await expect(commands.vouchFor?.({ memberId: "ana", friendId: "zoe" })).rejects.toThrow(
      ProcessingRestrictedError,
    );
    accesses.length = 0;
    await expect(
      commands.vouchFor?.(
        { memberId: "ana", friendId: "zoe" },
        { processRestricted: "legal-claims" },
      ),
    ).rejects.toMatchObject({ rejected: "Stranger" });
    expect(
      accesses
        .filter(({ operation }) => operation === "command")
        .map(({ persons, restricted }) => [persons, restricted]),
    ).toEqual([[["zoe"], { basis: "legal-claims", personCount: 1, persons: ["zoe"] }]]);
    await app.stop();
  });

  it("refuses a policy the data of a restricted person, which its letter then names", async () => {
    const { app, storage, commands } = await setup();
    await app.restrict("bea", { ground: "accuracy-contested" });
    await commands.vouchFor?.(
      { memberId: "ana", friendId: "bea" },
      { processRestricted: "legal-claims" },
    );
    await app.runUntilIdle();
    const [letter] = await storage.deadLetterStore.list({ kind: "policy" });
    expect(letter).toMatchObject({ errorName: "ProcessingRestrictedError", person: "bea" });
    await app.stop();
  });
});

describe("a projection's raw read", () => {
  it("seals what it throws under whom rawReadOf names", async () => {
    const { app, storage } = await vouched();
    expect(new Set(rawReads)).toEqual(new Set(["bea"]));
    const failure = await storage.subscriberFailures.get("projection:members");
    expect(failure).toMatchObject({ person: "ana", readPersons: ["bea"] });
    expect(JSON.stringify(failure)).not.toContain("Bea Sanz");
    expect((await app.exportPersonalData("bea")).subscriberFailures).toEqual([
      expect.objectContaining({ errorMessage: null }),
    ]);
    expect(await app.subscriberFailures.get("projection:members")).toMatchObject({
      errorMessage: "cannot list Bea Sanz",
    });
    await app.forget("bea");
    expect(await app.subscriberFailures.get("projection:members")).toMatchObject({
      errorMessage: null,
    });
    await app.stop();
  });
});

describe("a query", () => {
  it("names in the access log whom its port and raw reads returned data of", async () => {
    const { app, queries, accesses } = await setup();
    accesses.length = 0;
    await expect(queries.whoIs?.({ personId: "zoe" })).resolves.toEqual({
      personId: "zoe",
      name: "Zoe Ruiz",
    });
    await expect(queries.rawWhoIs?.({ personId: "bea" })).resolves.toBe("bea");
    expect(accesses.map(({ operation, persons }) => [operation, persons])).toEqual([
      ["query", ["zoe"]],
      ["query", ["bea"]],
    ]);
    await app.stop();
  });

  it("refuses the data of a restricted person unless it includes restricted data", async () => {
    const { app, queries, accesses } = await setup();
    await app.restrict("zoe", { ground: "accuracy-contested" });
    await expect(queries.whoIs?.({ personId: "zoe" })).rejects.toThrow(ProcessingRestrictedError);
    await expect(queries.rawWhoIs?.({ personId: "zoe" })).rejects.toThrow(
      ProcessingRestrictedError,
    );
    accesses.length = 0;
    await queries.whoIs?.({ personId: "zoe" }, { includeRestricted: "legal-claims" });
    expect(accesses.map(({ restricted }) => restricted)).toEqual([
      { basis: "legal-claims", personCount: 1, persons: ["zoe"] },
    ]);
    await app.stop();
  });
});

describe("a declared read", () => {
  it("counts as read of the person when the run tells a recipient", async () => {
    const { app, commands } = await setup();
    introducing = true;
    expect(await app.recipientsOf("bea")).toContainEqual(
      expect.objectContaining({ port: "member.notifier", status: "declared" }),
    );
    await commands.joinMember?.({ memberId: "cai", name: "Cai" });
    await app.runUntilIdle();
    await commands.vouchFor?.({ memberId: "cai", friendId: "bea" });
    await app.runUntilIdle();
    expect(await app.recipientsOf("bea")).toContainEqual(
      expect.objectContaining({ port: "member.notifier", status: "disclosed" }),
    );
    await app.stop();
  });

  it("let through on a process's basis is in its access record", async () => {
    const { app, commands, accesses } = await setup();
    await app.restrict("bea", { ground: "accuracy-contested" });
    accesses.length = 0;
    await commands.vouchFor?.(
      { memberId: "ana", friendId: "bea" },
      { processRestricted: "legal-claims" },
    );
    await app.runUntilIdle();
    expect(
      accesses
        .filter(({ operation }) => operation === "process")
        .map(({ persons, restricted }) => [persons, restricted]),
    ).toEqual([[["bea"], { basis: "legal-claims", personCount: 1, persons: ["bea"] }]]);
    await app.stop();
  });
});

describe("a query of a read model that holds no personal data", () => {
  it("is recorded only when a port or a raw read said it returned someone's data", async () => {
    const { app, queries, accesses } = await setup();
    accesses.length = 0;
    await queries.nobody?.({});
    await queries.rawNobody?.({});
    await queries.find?.({ personId: "zoe" });
    await queries.rawFind?.({ personId: "bea", named: true });
    expect(accesses.map(({ operation, persons }) => [operation, persons])).toEqual([
      ["query", ["zoe"]],
      ["query", ["bea"]],
    ]);
    await expect(queries.rawFind?.({ personId: "bea", named: false })).rejects.toThrow(
      'Read model "people": rawReadOf names no categories, and the read model marks no field .personal(): name the categories the read returned',
    );
    await app.restrict("zoe", { ground: "accuracy-contested" });
    accesses.length = 0;
    await expect(queries.find?.({ personId: "zoe" })).rejects.toThrow(ProcessingRestrictedError);
    expect(
      accesses.map(({ operation, outcome, persons }) => [operation, outcome, persons]),
    ).toEqual([["query", "failed", []]]);
    await expect(queries.rawFind?.({ personId: "", named: true })).rejects.toThrow(
      'Read model "people": rawReadOf named "", which is no person id',
    );
    await expect(queries.rawFind?.({ personId: "bea" })).rejects.toThrow(
      'Read model "people": rawReadOf names the category "contacts", which the app does not have',
    );
    await app.stop();
  });
});

describe("a recipient's handler", () => {
  it("seals what it throws under whom its port's answer holds data of", async () => {
    const { app, storage, commands } = await setup();
    introducing = true;
    await commands.vouchFor?.({ memberId: "ana", friendId: "bea" });
    await app.runUntilIdle();
    confirming = true;
    await app.forget("bea");
    await app.runUntilIdle();
    const letters = await storage.deadLetterStore.list({});
    const told = letters.find(({ handler }) => handler === "member.notifier");
    expect(told).toMatchObject({ readPersons: ["zoe"] });
    expect(JSON.stringify(told)).not.toContain("Zoe Ruiz");
    await app.stop();
  });
});

describe("a reaction", () => {
  it("seals what a command it dispatched throws under whom the command's port named", async () => {
    const { app, storage, commands } = await setup();
    reacting.checking = true;
    await commands.vouchFor?.({ memberId: "ana", friendId: "bea" });
    await app.runUntilIdle();
    const letter = (await storage.deadLetterStore.list({ kind: "policy" })).find(
      ({ handler }) => handler === "member.checkOnMemberVouched",
    );
    expect(letter).toMatchObject({ readPersons: ["bea"] });
    expect(JSON.stringify(letter)).not.toContain("Bea Sanz");
    await app.stop();
  });

  it("logs whom a policy's basis let it read through a port", async () => {
    const { app, commands, accesses } = await setup();
    await app.restrict("bea", { ground: "accuracy-contested" });
    reacting.onBasis = true;
    accesses.length = 0;
    await commands.vouchFor?.(
      { memberId: "ana", friendId: "bea" },
      { processRestricted: "legal-claims" },
    );
    await app.runUntilIdle();
    expect(
      accesses
        .filter(({ operation }) => operation === "policy")
        .map(({ persons, restricted }) => [persons, restricted]),
    ).toEqual([[["bea"], { basis: "legal-claims", personCount: 1, persons: ["bea"] }]]);
    await app.stop();
  });

  it("of a process, seals what it throws under whom its port named", async () => {
    const { app, storage, commands } = await setup();
    reacting.failingProcess = true;
    await commands.vouchFor?.({ memberId: "ana", friendId: "bea" });
    await app.runUntilIdle();
    const [letter] = await storage.deadLetterStore.list({ kind: "process" });
    expect(letter).toMatchObject({ readPersons: ["bea"] });
    expect(JSON.stringify(letter)).not.toContain("Bea Sanz");
    await app.stop();
  });
});

describe("a query that tells a recipient", () => {
  it("records as disclosed the data its port returned", async () => {
    const { app, queries } = await setup();
    expect(await app.recipientsOf("bea")).toContainEqual(
      expect.objectContaining({ port: "people.audience", status: "declared" }),
    );
    await queries.share?.({ personId: "bea" });
    expect(await app.recipientsOf("bea")).toContainEqual(
      expect.objectContaining({ port: "people.audience", status: "disclosed" }),
    );
    await app.stop();
  });
});
