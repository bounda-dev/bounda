import { afterEach, describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConcurrencyError, ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { createApp } from "../../kernel/app.ts";
import { masterKey } from "../../kernel/personal-data/master-key.ts";
import type { TenantExportPart } from "../../kernel/personal-data/tenant-export.ts";
import {
  readTenantExport,
  tenantExportJsonLines,
} from "../../kernel/personal-data/tenant-export-json.ts";
import { defineTenantKeyStore } from "../../kernel/personal-data/tenant-key-source.ts";
import { DEFAULT_TENANT } from "../../kernel/personal-data/tenant-keys.ts";
import { memory } from "../../memory/index.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import type { PersonalDataAccess } from "../../modules/audit.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import type { Adapter, ReadModelStorage, Storage } from "../adapter.ts";
import type { Table } from "../storage/table.ts";

export interface TenantExportContractArgs {
  /**
   * A fresh, empty database.
   */
  readonly create: () => Promise<Adapter>;
}

export interface TenantExportContractFunction {
  (args: TenantExportContractArgs): void;
}

interface NoteRow {
  readonly noteId: string;
  readonly memberId: string;
  readonly note: string | null;
}

type Dispatch = (payload: unknown, options?: unknown) => Promise<unknown>;

// A member's notes, each an event and a row, and for one that fails its policy a dead letter.
const registry = {
  aggregates: {
    member: {
      stateFingerprint: "tenant-export-contract",
      state: { initialState: {} },
      events: {
        memberNoted: {
          payload: ({ z, personal, notPersonal }: EventPayloadArgs) =>
            z.object({ note: personal(z.string()), topic: notPersonal(z.string()) }),
          evolve: ({ state }: { state: object }) => state,
        },
      },
      commands: {
        noteMember: {
          module: {
            payload: ({ z, personal, notPersonal }: CommandPayloadArgs) =>
              z.object({ memberId: notPersonal(z.string()), note: personal(z.string()) }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { note: string } };
              events: Readonly<Record<string, (payload: unknown) => unknown>>;
            }) => [events.memberNoted?.({ note: command.payload.note, topic: "general" })],
          },
        },
      },
      policies: {
        refuseOnMemberNoted: {
          module: {
            handler: async ({
              event,
              commands,
            }: {
              event: { payload: { note: string | null } };
              commands: Readonly<Record<string, Dispatch>>;
            }) => {
              const note = event.payload.note;
              // Reads the other member's notes before it gives up, quoting what it read.
              const other = note?.match(/^fail for (\w+)$/)?.[1];
              if (other !== undefined) {
                await commands.noteMember?.({ memberId: other, note: "seen" });
              }
              if (note?.startsWith("fail") === true) {
                throw new ValidationError(`refused ${note}`, []);
              }
            },
          },
        },
      },
      processes: {},
    },
  },
  readModels: {
    notes: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          noteId: f.string().primaryKey().notPersonal(),
          memberId: f.string().person(),
          note: f.string().optional().personal(),
        }),
      },
      projections: {
        member: {
          memberNoted: {
            project: ({
              event,
              table,
            }: {
              event: StoredEvent<"MemberNoted", { note: string | null }>;
              table: Table<NoteRow>;
            }) =>
              table.upsert({
                noteId: event.id,
                memberId: event.aggregateId,
                note: event.payload.note,
              }),
          },
        },
      },
      queries: {},
    },
  },
} as unknown as Registry;

const BATCH_SIZE = 4;
const NOTES = 3 * BATCH_SIZE + 1;
const MEMBERS = 2 * BATCH_SIZE + 1;

// How many records the export's reads brought back, the largest of them, and what to do once
// before the next page of the stream is read.
interface Reads {
  read: number;
  largest: number;
  meanwhile?: (() => Promise<void>) | undefined;
}

const counted = <Args extends unknown[], Item>(
  reads: Reads,
  read: (...args: Args) => Promise<readonly Item[]>,
) => {
  return async (...args: Args): Promise<readonly Item[]> => {
    const items = await read(...args);
    reads.read += items.length;
    reads.largest = Math.max(reads.largest, items.length);
    return items;
  };
};

const countingReads = (adapter: Adapter, reads: Reads): Adapter => ({
  ...adapter,
  createStorage: async (): Promise<Storage> => {
    const storage = await adapter.createStorage();
    return {
      ...storage,
      eventStore: {
        ...storage.eventStore,
        readAll: counted(reads, async (args) => {
          const meanwhile = reads.meanwhile;
          reads.meanwhile = undefined;
          await meanwhile?.();
          return storage.eventStore.readAll(args);
        }),
      },
      persons: { ...storage.persons, scan: counted(reads, (args) => storage.persons.scan(args)) },
      personalKeys: {
        ...storage.personalKeys,
        persons: counted(reads, (args) => storage.personalKeys.persons(args)),
      },
      scheduler: {
        ...storage.scheduler,
        scan: counted(reads, (args) => storage.scheduler.scan(args)),
      },
      deadLetterStore: {
        ...storage.deadLetterStore,
        scan: counted(reads, (args) => storage.deadLetterStore.scan(args)),
      },
      idempotencyStore: {
        ...storage.idempotencyStore,
        list: counted(reads, (args) => storage.idempotencyStore.list(args)),
      },
    };
  },
  createReadModel: async <Row extends object>(
    args: Parameters<Adapter["createReadModel"]>[0],
  ): Promise<ReadModelStorage<Row>> => {
    const opened = await adapter.createReadModel<Row>(args);
    return {
      ...opened,
      table: {
        ...opened.table,
        findMany: counted(reads, (query) => opened.table.findMany(query)),
      },
    };
  },
});

const collect = async (parts: AsyncIterable<TenantExportPart>): Promise<TenantExportPart[]> => {
  const collected: TenantExportPart[] = [];
  for await (const part of parts) collected.push(part);
  return collected;
};

const of = <Kind extends TenantExportPart["kind"]>(
  parts: readonly TenantExportPart[],
  kind: Kind,
): Extract<TenantExportPart, { readonly kind: Kind }>[] =>
  parts.filter(
    (part): part is Extract<TenantExportPart, { readonly kind: Kind }> => part.kind === kind,
  );

/**
 * Hands every record of the tenant back, every value opened, a page at a time on the adapter's
 * database, ends whole, and fails without its end once the stream moves while it reads.
 */
export const tenantExportContract: TenantExportContractFunction = ({ create }) => {
  describe("tenant export contract", () => {
    const stops: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const stop of stops.splice(0)) await stop();
    });

    const open = async () => {
      const reads: Reads = { read: 0, largest: 0 };
      const accesses: PersonalDataAccess[] = [];
      const app = await createApp({
        registry: {
          ...registry,
          audit: {
            onPersonalDataAccess: ({ access }: { access: PersonalDataAccess }) => {
              accesses.push(access);
            },
          },
        } as unknown as Registry,
        config: {
          storage: countingReads(await create(), reads),
          runtime: {
            dispatcher: { batchSize: BATCH_SIZE },
            policies: { retry: { strategy: "none" } },
            personalData: {
              keyWrapper: masterKey({ from: "EXPORT_KEY" }),
              // Apart from the database, as they live in production.
              tenantKeys: defineTenantKeyStore(() => createMemoryTenantKeyStore()),
              forgetLedger: { store: memory() },
            },
          },
        },
        clock: createFixedClock(new Date("2026-03-01T00:00:00.000Z")),
        env: { EXPORT_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) },
      });
      stops.push(() => app.stop());
      const commands = app.commands as unknown as Readonly<Record<string, Dispatch>>;
      const note = (memberId: string, text: string, options?: unknown) =>
        commands.noteMember?.({ memberId, note: text }, options);
      return { app, reads, accesses, note };
    };

    // A tenant's history: notes, one remembered under an idempotency key, one scheduled, one that
    // fails its policy after it read another member's data, a member restricted, one forgotten,
    // a note redacted, and members enough for several pages of persons.
    const history = async ({ app, note }: Awaited<ReturnType<typeof open>>) => {
      for (let index = 0; index < NOTES; index += 1) {
        await note("ana", `note ${String(index).padStart(3, "0")}`);
      }
      await note("ana", "later", { delay: "1h" });
      await note("bob", "bob's own");
      await note("ana", "fail for bob");
      await note("carl", "carl's own");
      await note("dan", "dan's own");
      for (let index = 0; index < MEMBERS; index += 1) await note(`m-${index}`, "a member");
      await app.runUntilIdle();
      await app.forget("carl");
      await app.restrict("dan", { ground: "accuracy-contested" });
      const redacted = (await app.exportPersonalData("ana")).events[0];
      await app.redact("ana", { events: [{ ...redacted, fields: ["note"] }] } as never);
      // After the redaction, which erases the answers remembered of the person.
      await note("ana", "remembered", { idempotencyKey: "k-1" });
      await app.runUntilIdle();
      return { redacted: redacted?.id };
    };

    it("hands back every record of the tenant, every value opened, and ends whole", async () => {
      const opened = await open();
      const { app } = opened;
      const { redacted } = await history(opened);
      const parts = await collect(await app.exportTenant(DEFAULT_TENANT));
      const header = parts[0]?.kind === "header" ? parts[0].header : undefined;
      expect(header).toEqual({
        format: "bounda.tenant-export",
        version: 1,
        tenant: DEFAULT_TENANT,
        exportId: expect.any(String),
        exportedAt: "2026-03-01T00:00:00.000Z",
        position: expect.any(Number),
        categories: { default: expect.objectContaining({ basis: null, purposes: [] }) },
        readModels: ["notes"],
      });
      const position = header?.position ?? -1;
      const members = Array.from({ length: MEMBERS }, (_, index) => `m-${index}`).sort();
      const persons = of(parts, "person").map(({ person }) => person);
      // Forgotten without a retention that keeps a record of them, Carl holds nothing but the
      // events that name them.
      expect(persons.map(({ personId }) => personId)).toEqual(["ana", "bob", "dan", ...members]);
      expect(persons.find(({ personId }) => personId === "dan")).toMatchObject({
        forgottenAt: null,
        categories: { default: { keptUntil: null, restrictedUntil: null } },
        restrictions: [{ ground: "accuracy-contested", categories: null }],
      });

      const events = of(parts, "event").map(({ event }) => event);
      expect(events.map((event) => event.position)).toEqual(
        Array.from({ length: position }, (_, index) => index + 1),
      );
      const notes = events.filter(({ type }) => type === "MemberNoted");
      expect(notes.find(({ aggregateId }) => aggregateId === "bob")).toMatchObject({
        person: "bob",
        payload: { note: "bob's own", topic: "general" },
        categories: { note: "default" },
        restricted: [],
        redacted: [],
        metadata: expect.objectContaining({ system: false }),
      });
      expect(notes.find(({ id }) => id === redacted)).toMatchObject({
        payload: { note: null, topic: "general" },
        redacted: ["note"],
      });
      expect(notes.find(({ aggregateId }) => aggregateId === "carl")).toMatchObject({
        payload: { note: null, topic: "general" },
      });
      expect(notes.find(({ aggregateId }) => aggregateId === "dan")).toMatchObject({
        payload: { note: "dan's own" },
        restricted: ["note"],
      });
      expect(events.map(({ type }) => type)).toEqual(
        expect.arrayContaining([
          "PersonalDataForgotten",
          "ProcessingRestricted",
          "PersonalDataRedacted",
        ]),
      );

      expect(of(parts, "scheduledCommand").map(({ scheduledCommand }) => scheduledCommand)).toEqual(
        [
          expect.objectContaining({
            type: "NoteMember",
            aggregateId: "ana",
            payload: { memberId: "ana", note: "later" },
            persons: ["ana"],
            categories: { note: "default" },
            restricted: [],
          }),
        ],
      );
      // Opened whatever else the text quotes: between processor and controller nothing is withheld.
      expect(of(parts, "deadLetter").map(({ deadLetter }) => deadLetter)).toEqual([
        expect.objectContaining({
          kind: "policy",
          person: "ana",
          readPersons: ["bob"],
          errorMessage: "refused fail for bob",
          errorStack: expect.stringContaining("refused fail for bob"),
          status: "failed",
          persons: [],
          restricted: [],
        }),
      ]);
      expect(of(parts, "answer").map(({ answer }) => answer)).toEqual([
        expect.objectContaining({ idempotencyKey: "k-1", persons: ["ana"], restricted: [] }),
      ]);
      const rows = of(parts, "row");
      expect(rows.every(({ readModel }) => readModel === "notes")).toBe(true);
      expect(rows.map(({ row }) => row.key)).toEqual(
        notes.map(({ id }) => id).sort((a, b) => (a < b ? -1 : 1)),
      );
      expect(rows.find(({ row }) => row.person === "dan")?.row).toEqual({
        key: expect.any(String),
        data: { noteId: expect.any(String), memberId: "dan", note: "dan's own" },
        person: "dan",
        categories: { note: "default" },
        restricted: ["note"],
      });
      expect(rows.find(({ row }) => row.person === "carl")?.row.data).toMatchObject({
        note: null,
      });
      const entries = of(parts, "forgetLedgerEntry").map(({ entry }) => entry);
      expect(entries.map(({ personId }) => personId).sort()).toEqual(
        expect.arrayContaining(["ana", "carl", "dan"]),
      );

      const records = parts.length - 2;
      expect(parts.at(-1)).toEqual({
        kind: "end",
        counts: {
          persons: persons.length,
          events: events.length,
          scheduledCommands: 1,
          deadLetters: 1,
          subscriberFailures: 0,
          answers: 1,
          readModelRows: rows.length,
          forgetLedgerEntries: entries.length,
        },
      });
      expect(persons.length + events.length + 3 + rows.length + entries.length).toBe(records);
      expect(parts.map(({ kind }) => kind)).toEqual([
        "header",
        ...persons.map(() => "person"),
        ...events.map(() => "event"),
        "scheduledCommand",
        "deadLetter",
        "answer",
        ...rows.map(() => "row"),
        ...entries.map(() => "forgetLedgerEntry"),
        "end",
      ]);
      expect(JSON.stringify(parts)).not.toContain("$personal");
    });

    it("writes JSON Lines that read back as the same parts, checked whole", async () => {
      const opened = await open();
      await history(opened);
      const parts = await collect(await opened.app.exportTenant(DEFAULT_TENANT));
      const read = await collect(
        readTenantExport(tenantExportJsonLines(await opened.app.exportTenant(DEFAULT_TENANT))),
      );
      const { exportId: _first, ...header } =
        parts[0]?.kind === "header" ? parts[0].header : ({} as never);
      const { exportId: _second, ...again } =
        read[0]?.kind === "header" ? read[0].header : ({} as never);
      expect(again).toEqual(header);
      expect(read.slice(1)).toEqual(JSON.parse(JSON.stringify(parts.slice(1))));
    });

    it("holds no more than a page or two of records at once, whatever the tenant holds", async () => {
      const opened = await open();
      await history(opened);
      const { app, reads } = opened;
      reads.read = 0;
      reads.largest = 0;
      let handed = 0;
      let most = 0;
      for await (const part of await app.exportTenant(DEFAULT_TENANT)) {
        if (part.kind !== "header" && part.kind !== "end") handed += 1;
        most = Math.max(most, reads.read - handed);
      }
      expect(handed).toBeGreaterThan(8 * BATCH_SIZE);
      // The persons are merged from two stores, a page of each held while they are.
      expect(most).toBeLessThanOrEqual(2 * BATCH_SIZE);
      expect(reads.largest).toBeLessThanOrEqual(BATCH_SIZE);
    });

    it("fails without its end once the stream moves past its head while it reads, recorded failed", async () => {
      const opened = await open();
      await history(opened);
      const { app, reads, note, accesses } = opened;
      accesses.length = 0;
      reads.meanwhile = async () => {
        await note("bob", "meanwhile");
      };
      const parts: TenantExportPart[] = [];
      const reading = async () => {
        for await (const part of await app.exportTenant(DEFAULT_TENANT)) parts.push(part);
      };
      await expect(reading()).rejects.toBeInstanceOf(ConcurrencyError);
      const position = parts[0]?.kind === "header" ? parts[0].header.position : -1;
      expect(of(parts, "event").every(({ event }) => event.position <= position)).toBe(true);
      expect(parts.some(({ kind }) => kind === "end")).toBe(false);
      expect(accesses.map(({ outcome }) => outcome)).toEqual(["started", "failed"]);
      expect(accesses.at(-1)).toMatchObject({
        operation: "exportTenant",
        errorName: "TenantDataChangedError",
        errorCode: "CONCURRENCY_CONFLICT",
      });
      await expect(
        collect(
          readTenantExport(
            tenantExportJsonLines(
              (async function* () {
                yield* parts;
              })(),
            ),
          ),
        ),
      ).rejects.toThrow("ends before its end part");
    });

    it("records the export as it starts and as it ends, naming the first persons and counting them all", async () => {
      const opened = await open();
      await history(opened);
      const { app, accesses } = opened;
      accesses.length = 0;
      const parts = await collect(await app.as("ops-1").exportTenant(DEFAULT_TENANT));
      const header = parts[0]?.kind === "header" ? parts[0].header : undefined;
      const end = parts.at(-1)?.kind === "end" ? (parts.at(-1) as { counts: object }) : undefined;
      expect(accesses).toEqual([
        {
          operation: "exportTenant",
          actor: "ops-1",
          persons: [],
          personCount: 0,
          at: "2026-03-01T00:00:00.000Z",
          outcome: "started",
          errorName: null,
          errorCode: null,
          restricted: null,
          detail: {
            exportId: header?.exportId,
            persons: 0,
            events: 0,
            scheduledCommands: 0,
            deadLetters: 0,
            subscriberFailures: 0,
            answers: 0,
            readModelRows: 0,
            forgetLedgerEntries: 0,
          },
        },
        expect.objectContaining({
          operation: "exportTenant",
          actor: "ops-1",
          persons: of(parts, "person").map(({ person }) => person.personId),
          personCount: MEMBERS + 3,
          outcome: "ok",
          detail: { exportId: header?.exportId, ...end?.counts },
        }),
      ]);
      accesses.length = 0;
      for await (const part of await app.exportTenant(DEFAULT_TENANT)) {
        if (part.kind === "event") break;
      }
      expect(accesses.map(({ outcome }) => outcome)).toEqual(["started", "cancelled"]);
      expect(accesses.at(-1)).toMatchObject({
        personCount: MEMBERS + 3,
        detail: { persons: MEMBERS + 3, events: 1 },
      });
    });

    it("refuses another tenant before it reads anything, recorded refused", async () => {
      const { app, accesses, reads, note } = await open();
      await note("ana", "a note");
      await app.runUntilIdle();
      accesses.length = 0;
      reads.read = 0;
      await expect(app.exportTenant("another")).rejects.toBeInstanceOf(ValidationError);
      expect(reads.read).toBe(0);
      expect(accesses).toEqual([
        expect.objectContaining({
          operation: "exportTenant",
          persons: [],
          personCount: 0,
          outcome: "refused",
          errorName: "ValidationError",
        }),
      ]);
    });

    it("hands back a tenant that holds nothing as a header and an end", async () => {
      const { app } = await open();
      const parts = await collect(await app.exportTenant(DEFAULT_TENANT));
      expect(parts.map(({ kind }) => kind)).toEqual(["header", "end"]);
      expect(parts[0]).toMatchObject({ header: { position: 0 } });
    });
  });
};
