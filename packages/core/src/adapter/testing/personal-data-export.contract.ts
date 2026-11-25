import { afterEach, describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConcurrencyError, ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { type BoundaApp, createApp } from "../../kernel/app.ts";
import type {
  PersonalDataExport,
  PersonalDataExportPart,
} from "../../kernel/personal-data/export.ts";
import { personalDataExportJson } from "../../kernel/personal-data/export-json.ts";
import { masterKey } from "../../kernel/personal-data/master-key.ts";
import { defineTenantKeyStore } from "../../kernel/personal-data/tenant-key-source.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import type { PersonalDataAccess } from "../../modules/audit.ts";
import { PERSONAL_DATA_REDACTED_EVENT } from "../../modules/bounda-events.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import type { Adapter, ReadModelStorage, Storage } from "../adapter.ts";
import type { Table } from "../storage/table.ts";

export interface PersonalDataExportContractArgs {
  /**
   * A fresh, empty database.
   */
  readonly create: () => Promise<Adapter>;
}

export interface PersonalDataExportContractFunction {
  (args: PersonalDataExportContractArgs): void;
}

interface NoteRow {
  readonly noteId: string;
  readonly memberId: string;
  readonly note: string | null;
}

type Dispatch = (payload: unknown, options?: unknown) => Promise<unknown>;

// A member's notes, each an event, a row and, for one that fails its policy, a dead letter.
const registry = {
  aggregates: {
    member: {
      stateFingerprint: "personal-data-export-contract",
      state: { initialState: {} },
      events: {
        memberNoted: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ note: personal(z.string()) }),
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
            }) => [events.memberNoted?.({ note: command.payload.note })],
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
const NOTES = 9 * BATCH_SIZE + 1;
const REDACTED = 2 * BATCH_SIZE + 1;

const redactable = ({
  aggregateType,
  aggregateId,
  type,
  id,
}: PersonalDataExport["events"][number]) => ({
  aggregateType,
  aggregateId,
  type,
  id,
  fields: ["note"],
});

// The most records the export held at once while it was read whole, and how many it handed out.
const held = async (app: BoundaApp, reads: Reads) => {
  reads.read = 0;
  reads.largest = 0;
  let handed = 0;
  let records = 0;
  for await (const part of await app.streamPersonalData("ana")) {
    if (part.kind !== "header") handed += 1;
    records = Math.max(records, reads.read - handed);
    if (handed === 1) expect(reads.read).toBeLessThanOrEqual(BATCH_SIZE);
  }
  return { handed, records };
};

// How many records the export's reads brought back, and how many parts it handed out: the
// difference is what it holds at once. A load of the person's own stream counts its redactions,
// which become parts, and every event it brought back towards the largest read.
interface Reads {
  read: number;
  largest: number;
  // Run once, before the next page of the person's events is read.
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
        load: async (args) => {
          const loaded = await storage.eventStore.load(args);
          reads.read += loaded.events.filter(
            ({ type }) => type === PERSONAL_DATA_REDACTED_EVENT,
          ).length;
          reads.largest = Math.max(reads.largest, loaded.events.length);
          return loaded;
        },
        readByPerson: counted(reads, async (args) => {
          const meanwhile = reads.meanwhile;
          reads.meanwhile = undefined;
          await meanwhile?.();
          return storage.eventStore.readByPerson(args);
        }),
      },
      scheduler: {
        ...storage.scheduler,
        listByPerson: counted(reads, (args) => storage.scheduler.listByPerson(args)),
      },
      deadLetterStore: {
        ...storage.deadLetterStore,
        listByPerson: counted(reads, (args) => storage.deadLetterStore.listByPerson(args)),
      },
      idempotencyStore: {
        ...storage.idempotencyStore,
        listByPerson: counted(reads, (args) => storage.idempotencyStore.listByPerson(args)),
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

const textOf = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
};

/**
 * Exports a long history a page at a time on the adapter's database, as the in-memory export does
 * and the same JSON, holding no more than a page at once, and fails it once the person's own
 * stream moves while it reads.
 */
export const personalDataExportContract: PersonalDataExportContractFunction = ({ create }) => {
  describe("personal data export contract", () => {
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
            onHostRejection: () => {},
          },
        } as unknown as Registry,
        config: {
          storage: countingReads(await create(), reads),
          runtime: {
            dispatcher: { batchSize: BATCH_SIZE },
            policies: { retry: { strategy: "none" } },
            personalData: {
              keyWrapper: masterKey({ from: "EXPORT_KEY" }),
              // Apart from the database, as it lives in production.
              tenantKeys: defineTenantKeyStore(() => createMemoryTenantKeyStore()),
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

    // A long history: notes, one remembered under an idempotency key, one scheduled, two that fail
    // their policy, and another member's.
    const history = async (note: Awaited<ReturnType<typeof open>>["note"], app: BoundaApp) => {
      for (let index = 0; index < NOTES; index += 1) {
        await note("ana", `note ${String(index).padStart(3, "0")}`);
      }
      await note("ana", "remembered", { idempotencyKey: "k-1" });
      await note("ana", "later", { delay: "1h" });
      await note("ana", "fail once");
      await note("ana", "fail twice");
      await note("bob", "not ana's");
      await app.runUntilIdle();
    };

    it("holds back from each person the text of work that read someone else's data, and opens it marked when asked", async () => {
      const { app, note, accesses } = await open();
      await note("bob", "bob's own");
      await note("ana", "fail for bob");
      await app.runUntilIdle();
      const withheld = ["errorMessage", "errorStack"].map((field) => ({
        field,
        reason: "rights-of-others",
        article: "15(4)",
      }));
      for (const person of ["ana", "bob"]) {
        const exported = await app.exportPersonalData(person);
        expect(exported.deadLetters).toEqual([
          expect.objectContaining({ errorMessage: null, errorStack: null, withheld }),
        ]);
        expect(JSON.stringify(exported)).not.toContain("refused fail for bob");
      }
      accesses.length = 0;
      const opened = await app.exportPersonalData("bob", { includeWithheld: true });
      expect(opened.deadLetters).toEqual([
        expect.objectContaining({ errorMessage: "refused fail for bob", withheld }),
      ]);
      expect(accesses.at(-1)).toMatchObject({
        outcome: "ok",
        persons: ["bob", "ana"],
        detail: { withheld: 1, includeWithheld: true },
      });
      const text = await textOf(
        personalDataExportJson(await app.streamPersonalData("ana", { includeWithheld: true })),
      );
      expect(text).toContain("refused fail for bob");
    });

    it("hands out what exportPersonalData answers, a part at a time, and writes it as the same JSON", async () => {
      const { app, note } = await open();
      await history(note, app);
      const whole = await app.exportPersonalData("ana");
      expect(whole.events).toHaveLength(NOTES + 3);
      expect(whole.scheduledCommands).toHaveLength(1);
      expect(whole.deadLetters).toHaveLength(2);
      expect(whole.answers).toHaveLength(1);
      expect(whole.readModels.notes).toHaveLength(NOTES + 3);
      expect(whole.position).toBe(NOTES + 4);

      const parts: PersonalDataExportPart[] = [];
      for await (const part of await app.streamPersonalData("ana")) parts.push(part);
      expect(parts[0]).toEqual({
        kind: "header",
        header: {
          personId: "ana",
          exportedAt: whole.exportedAt,
          position: whole.position,
          categories: whole.categories,
          rights: whole.rights,
          automatedDecisions: [],
          restrictions: [],
          recipients: [],
          transfers: [],
          readModels: ["notes"],
        },
      });
      expect(parts.filter((part) => part.kind === "event").map((part) => part.event)).toEqual(
        whole.events,
      );
      expect(parts.map(({ kind }) => kind)).toEqual([
        "header",
        ...whole.events.map(() => "event"),
        "scheduledCommand",
        "deadLetter",
        "deadLetter",
        "answer",
        ...(whole.readModels.notes ?? []).map(() => "row"),
      ]);

      const text = await textOf(personalDataExportJson(await app.streamPersonalData("ana")));
      expect(text).toBe(JSON.stringify(whole, null, 2));
      expect(JSON.parse(text)).toEqual(whole);
    });

    it("holds no more than a page of records at once, whatever the history", async () => {
      const { app, reads, note } = await open();
      await history(note, app);
      const most = await held(app, reads);
      expect(most.handed).toBe(2 * (NOTES + 3) + 4);
      expect(most.records).toBeLessThanOrEqual(BATCH_SIZE);
      expect(reads.largest).toBeLessThanOrEqual(BATCH_SIZE);
    });

    it("holds no more than a page of a heavily redacted history, each event saying what was redacted", async () => {
      const { app, reads, note } = await open();
      await history(note, app);
      const { events } = await app.exportPersonalData("ana");
      // One redaction an event, and one of several at once.
      const notes = events.slice(0, REDACTED).map(redactable);
      for (const target of notes.slice(0, -BATCH_SIZE)) {
        await app.redact("ana", { events: [target] } as never);
      }
      await app.redact("ana", { events: notes.slice(-BATCH_SIZE) } as never);
      await app.runUntilIdle();
      const whole = await app.exportPersonalData("ana");
      expect(whole.redactions).toHaveLength(REDACTED - BATCH_SIZE + 1);
      expect(whole.redactions.at(-1)?.events.map(({ id }) => id)).toEqual(
        notes.slice(-BATCH_SIZE).map(({ id }) => id),
      );
      expect(whole.events.filter(({ redacted }) => redacted.length > 0)).toEqual(
        notes.map(({ id }) =>
          expect.objectContaining({ id, data: { note: null }, redacted: ["note"] }),
        ),
      );
      const most = await held(app, reads);
      expect(most.handed).toBe(
        whole.redactions.length +
          whole.events.length +
          whole.scheduledCommands.length +
          whole.deadLetters.length +
          whole.subscriberFailures.length +
          whole.answers.length +
          (whole.readModels.notes?.length ?? 0),
      );
      expect(most.records).toBeLessThanOrEqual(BATCH_SIZE);
      expect(reads.largest).toBeLessThanOrEqual(BATCH_SIZE);
      const text = await textOf(personalDataExportJson(await app.streamPersonalData("ana")));
      expect(text).toBe(JSON.stringify(whole, null, 2));
    });

    it("leaves out the events past its head, and fails once the person's own stream moves while it reads", async () => {
      const { app, note, accesses } = await open();
      await history(note, app);
      const parts = (await app.streamPersonalData("ana"))[Symbol.asyncIterator]();
      const header = await parts.next();
      const position = header.value?.kind === "header" ? header.value.header.position : -1;
      expect(position).toBe(NOTES + 4);
      await parts.next();
      await note("ana", "after the head");
      await app.restrict("ana", { ground: "accuracy-contested" });
      const events: number[] = [];
      const rest = async () => {
        for (;;) {
          const next = await parts.next();
          if (next.done === true) return;
          if (next.value.kind === "event") events.push(next.value.event.position);
        }
      };
      await expect(rest()).rejects.toBeInstanceOf(ConcurrencyError);
      expect(Math.max(...events)).toBeLessThanOrEqual(position);
      expect(accesses.at(-1)).toMatchObject({
        operation: "exportPersonalData",
        persons: ["ana"],
        outcome: "failed",
        detail: { events: NOTES + 3 },
      });
      const again = await app.exportPersonalData("ana");
      expect(again.restrictions).toEqual([
        { ground: "accuracy-contested", categories: null, since: expect.any(String) },
      ]);
      expect(again.events.at(-2)?.data).toEqual({ note: "after the head" });
    });

    it("reads again, whole, an export the person's changes overtook, before it hands anything out", async () => {
      const { app, reads, note, accesses } = await open();
      await history(note, app);
      reads.meanwhile = async () => {
        await app.redact("ana", {
          events: [
            {
              ...((await app.exportPersonalData("ana")).events[0] as {
                readonly aggregateType: string;
                readonly aggregateId: string;
                readonly type: string;
                readonly id: string;
              }),
              fields: ["note"],
            },
          ],
        } as never);
      };
      accesses.length = 0;
      const exported = await app.exportPersonalData("ana");
      expect(exported.redactions).toHaveLength(1);
      expect(exported.events[0]?.redacted).toEqual(["note"]);
      expect(accesses.map(({ outcome }) => outcome)).toEqual([
        "started",
        "started",
        "ok",
        "failed",
        "started",
        "ok",
      ]);
    });

    it("records how the reading ended, with what it handed out by then", async () => {
      const { app, note, accesses } = await open();
      await history(note, app);
      let handed = 0;
      for await (const part of await app.as("support-7").streamPersonalData("ana")) {
        if (part.kind === "event") handed += 1;
        if (handed === 2) break;
      }
      const stream = personalDataExportJson(await app.streamPersonalData("ana"));
      const reader = stream.getReader();
      await reader.read();
      await reader.cancel();
      await textOf(personalDataExportJson(await app.streamPersonalData("bob")));
      expect(accesses).toEqual([
        expect.objectContaining({ actor: "support-7", outcome: "started" }),
        expect.objectContaining({
          actor: "support-7",
          outcome: "cancelled",
          detail: expect.objectContaining({ events: 2, readModelRows: 0 }),
        }),
        expect.objectContaining({ actor: null, outcome: "started" }),
        expect.objectContaining({
          actor: null,
          outcome: "cancelled",
          detail: expect.objectContaining({ events: 0 }),
        }),
        expect.objectContaining({ persons: ["bob"], outcome: "started" }),
        expect.objectContaining({
          persons: ["bob"],
          outcome: "ok",
          detail: expect.objectContaining({ events: 1, readModelRows: 1 }),
        }),
      ]);
      const ids = accesses.map((access) =>
        access.operation === "exportPersonalData" ? access.detail.exportId : null,
      );
      expect(ids.filter((_, index) => index % 2 === 0)).toEqual(
        ids.filter((_, index) => index % 2 === 1),
      );
      expect(new Set(ids).size).toBe(3);
    });

    it("records an export as it starts, before its header is handed out, so one nobody reads to the end is recorded", async () => {
      const { app, note, accesses } = await open();
      await history(note, app);
      accesses.length = 0;
      const parts = (await app.as("support-7").streamPersonalData("ana"))[Symbol.asyncIterator]();
      expect(accesses).toEqual([
        {
          operation: "exportPersonalData",
          actor: "support-7",
          persons: ["ana"],
          personCount: 1,
          at: "2026-03-01T00:00:00.000Z",
          outcome: "started",
          errorName: null,
          errorCode: null,
          restricted: null,
          detail: {
            exportId: expect.any(String),
            redactions: 0,
            events: 0,
            scheduledCommands: 0,
            deadLetters: 0,
            subscriberFailures: 0,
            answers: 0,
            readModelRows: 0,
            recipients: 0,
            withheld: 0,
            includeWithheld: false,
          },
        },
      ]);
      await parts.next();
      await parts.next();
      // Left there, neither read to its end nor stopped: its start is all the log holds of it.
      expect(accesses.map(({ outcome }) => outcome)).toEqual(["started"]);
    });
  });
};
