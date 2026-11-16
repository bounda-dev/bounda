import type { ReadModelStorage } from "../../adapter/adapter.ts";
import type { StoredDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import { DEFAULT_PERSONAL_CATEGORY } from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { retentionEnd } from "../../contracts/duration.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { AccessOutcome } from "../../modules/audit.ts";
import {
  BOUNDA_AGGREGATE,
  PERSONAL_DATA_REDACTED_EVENT,
  type PersonalDataRedactedPayload,
} from "../../modules/bounda-events.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { scheduledCommandId } from "../command/pipeline.ts";
import type { AppStorage } from "../events/app-event-store.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { processOfStream } from "../process/lifecycle.ts";
import type { SealingSource } from "../projection/runner.ts";
import type {
  ReadModelPersonalData,
  ReadModelRuntime,
  ReadModelsRuntime,
} from "../read-model/build-read-models.ts";
import { openRow } from "../read-model/sealed-rows.ts";
import { createSealingKeyRing } from "../read-model/sealing-keys.ts";
import type { RecipientsRuntime } from "../recipients/build.ts";
import { PersonalDataChangedError } from "../recipients/gate.ts";
import { recipientsOf } from "../recipients/listing.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { openAnswer } from "./answers.ts";
import { formatRetention, type PersonalCategories } from "./categories.ts";
import { openCommandPayload, sealedKeys } from "./commands.ts";
import { openTextWith } from "./errors.ts";
import { openedUnder } from "./event-store.ts";
import {
  collectPersonalDataExport,
  countPart,
  type ExportedCategories,
  type ExportedCategory,
  type ExportedCounts,
  type ExportedData,
  type ExportedDeadLetter,
  type ExportedRedaction,
  type ExportedRestricted,
  NO_EXPORTED_RECORDS,
  type PersonalDataExport,
  type PersonalDataExportHeader,
  type PersonalDataExportPart,
} from "./export.ts";
import { fieldCategory, type PersonalMarks } from "./marks.ts";
import { lifecycleStateOf } from "./process-state.ts";
import { processingRestrictionsOf } from "./restriction.ts";
import { checkPersonId } from "./transact.ts";

export interface StreamPersonalDataArgs {
  /**
   * The app's storage, whose event store opens the fields and upcasts the payloads.
   */
  readonly storage: AppStorage;
  readonly aggregates: AggregatesRuntime;
  /**
   * Whose state schemas mark the fields their lifecycle events hold.
   */
  readonly processes: Pick<ProcessesRuntime, "byName">;
  readonly readModels: ReadModelsRuntime;
  /**
   * What the read models' values are opened with.
   */
  readonly sealing: SealingSource;
  readonly clock: Clock;
  /**
   * How many records each read takes: the export holds no more than one page of them at a time.
   */
  readonly batchSize: number;
  readonly categories: PersonalCategories;
  /**
   * The recipients the app declares, which the export lists beside those the store recorded.
   */
  readonly recipients: RecipientsRuntime;
  readonly personId: string;
}

export interface StreamPersonalDataFunction {
  (args: StreamPersonalDataArgs): Promise<AsyncGenerator<PersonalDataExportPart, void, undefined>>;
}

interface Marked {
  readonly data: ExportedData;
  readonly categories: ExportedCategories;
}

const markedFields = (marks: PersonalMarks | null, payload: unknown): Marked => {
  if (marks === null || !isRecord(payload)) return { data: {}, categories: {} };
  const fields = marks.fields.filter((field) => payload[field] !== undefined);
  return {
    data: Object.fromEntries(fields.map((field) => [field, payload[field]])),
    categories: Object.fromEntries(fields.map((field) => [field, fieldCategory(marks, field)])),
  };
};

// Pages by a key no write changes, so a record written or removed meanwhile cannot make another
// one skip a page or repeat; the last page is the first that comes back empty.
async function* paged<Item>(
  read: (after: string | undefined) => Promise<readonly Item[]>,
  keyOf: (item: Item) => string,
): AsyncGenerator<readonly Item[], void, undefined> {
  let after: string | undefined;
  for (;;) {
    const page = await read(after);
    if (page.length === 0) return;
    yield page;
    after = keyOf(page.at(-1) as Item);
  }
}

// Each read model through its own storage, which may be another adapter's.
async function* exportedRows(
  readModel: string,
  storage: ReadModelStorage,
  { person, personal, primaryKey }: ReadModelPersonalData,
  { fields, layout }: Pick<ReadModelRuntime, "fields" | "layout">,
  sealing: SealingSource,
  personId: string,
  batchSize: number,
  restricted: (categories: ExportedCategories) => ExportedRestricted,
): AsyncGenerator<PersonalDataExportPart & { readonly kind: "row" }, void, undefined> {
  // Holds the person's keys alone, each read once.
  const keys = createSealingKeyRing({ keys: sealing.keys, fetching: true });
  let after: unknown;
  for (;;) {
    const page = await storage.table.findMany({
      where: {
        [person]: personId,
        ...(after === undefined ? {} : { [primaryKey]: { gt: after } }),
      },
      orderBy: { field: primaryKey, direction: "asc" },
      limit: batchSize,
    });
    for (const stored of page) {
      // Every value opened, what a forgetting kept included: the export marks it restricted.
      const { row, retainedFields } = await openRow({
        context: { layout, keys },
        stored,
        hideRetained: false,
      });
      const held = personal.filter((field) => row[field] !== undefined);
      const categories = Object.fromEntries(
        held.map((field) => [field, fields[field]?.category ?? DEFAULT_PERSONAL_CATEGORY]),
      );
      yield {
        kind: "row",
        readModel,
        row: {
          key: row[primaryKey],
          data: Object.fromEntries(held.map((field) => [field, row[field]])),
          categories,
          restricted: [...new Set([...restricted(categories), ...retainedFields])],
        },
      };
    }
    after = page.at(-1)?.[primaryKey];
    // A person field that is the primary key names one row at most, and a range on it would
    // take the place of the person's own value.
    if (page.length < batchSize || person === primaryKey) return;
  }
}

// What a forgetting kept of a category goes once its retention has run from the activity it kept.
const categoriesOf = async (
  storage: AppStorage,
  categories: PersonalCategories,
  personId: string,
): Promise<Readonly<Record<string, ExportedCategory>>> => {
  const held = await storage.personalKeys.list(personId);
  return Object.fromEntries(
    categories.all.map(({ name, basis, retention }) => {
      const kept =
        retention === null
          ? []
          : held
              .filter(
                ({ category, retainedSince, lastActiveAt }) =>
                  category === name && retainedSince !== null && lastActiveAt !== null,
              )
              .map(({ lastActiveAt }) => retentionEnd(Date.parse(lastActiveAt ?? ""), retention));
      return [
        name,
        {
          basis,
          retention: retention === null ? null : formatRetention(retention),
          restrictedUntil: kept.length === 0 ? null : new Date(Math.max(...kept)).toISOString(),
        },
      ];
    }),
  );
};

interface PersonStream {
  readonly version: number;
  readonly redactions: readonly ExportedRedaction[];
}

// The runtime's events about the person: few, one per right they exercised.
const personStream = async (storage: AppStorage, personId: string): Promise<PersonStream> => {
  const { events, version } = await storage.eventStore.load({
    aggregateType: BOUNDA_AGGREGATE,
    aggregateId: personId,
  });
  return {
    version,
    redactions: events
      .filter((event) => event.type === PERSONAL_DATA_REDACTED_EVENT)
      .map((event) => ({
        eventId: event.id,
        at: event.timestamp,
        events: (event.payload as PersonalDataRedactedPayload).events.map(({ id, fields }) => ({
          id,
          fields,
        })),
      })),
  };
};

// Resolves once the header is read, so a refusal rejects before anything is handed out. What the
// person's own stream says of them holds for the whole export: a change to it since the start,
// found once the last page is read, rejects it with `PersonalDataChangedError`.
export const streamPersonalData: StreamPersonalDataFunction = async ({
  storage,
  aggregates,
  processes,
  readModels,
  sealing,
  clock,
  batchSize,
  categories,
  recipients,
  personId,
}) => {
  checkPersonId(personId, "exportPersonalData");
  const exportedAt = clock.now().toISOString();
  // The person's stream before the head: whatever it gains after this, the end finds.
  const before = await personStream(storage, personId);
  const position = await storage.eventStore.lastPosition();
  const restrictions = processingRestrictionsOf(await storage.persons.restrictions(personId));
  const exportedCategories = await categoriesOf(storage, categories, personId);
  const header: PersonalDataExportHeader = {
    personId,
    exportedAt,
    position,
    categories: exportedCategories,
    restrictions,
    redactions: before.redactions,
    recipients: await recipientsOf({ storage, recipients, categories, personId }),
    readModels: Object.values(readModels.byName)
      .filter(({ personalData }) => personalData !== null)
      .map(({ name }) => name),
  };
  const whole = restrictions.some((restriction) => restriction.categories === null);
  const requested = new Set<string>(
    restrictions.flatMap((restriction) => restriction.categories ?? []),
  );
  const kept = new Set<string>(
    Object.entries(exportedCategories)
      .filter(([, category]) => category.restrictedUntil !== null)
      .map(([name]) => name),
  );
  const fieldsIn = (of: ExportedCategories, covers: (category: string) => boolean) =>
    Object.entries(of)
      .filter(([, category]) => whole || covers(category))
      .map(([field]) => field);
  // What a restriction the person asked for covers.
  const requestedFields = (of: ExportedCategories): ExportedRestricted =>
    fieldsIn(of, (category) => requested.has(category));
  // And what a forgetting kept, by category, for a record that does not say its key.
  const restrictedFields = (of: ExportedCategories): ExportedRestricted =>
    fieldsIn(of, (category) => requested.has(category) || kept.has(category));
  // An event says the keys it was opened under, all of the one person it names: what a forgetting
  // kept is restricted only when one of them is a key it kept, so what the person wrote after they
  // came back is not.
  const eventRestricted = (event: StoredEvent, of: ExportedCategories): ExportedRestricted =>
    openedUnder(event).some(({ retained }) => retained === true)
      ? restrictedFields(of)
      : requestedFields(of);
  const textRestricted: ExportedRestricted =
    restrictions.length > 0 ? ["errorMessage", "errorStack"] : [];
  // The ids of the events redacted and their fields, never a value: what each event says in
  // `redacted`.
  const redactedOf = new Map<string, Set<string>>();
  for (const redaction of before.redactions) {
    for (const { id, fields } of redaction.events) {
      redactedOf.set(id, new Set([...(redactedOf.get(id) ?? []), ...fields]));
    }
  }
  // A process's lifecycle event holds the fields its state marks, in that state.
  const eventData = (event: StoredEvent): Marked => {
    const process = processOfStream(event.aggregateType);
    if (process === null) {
      const marks = aggregates.byName[event.aggregateType]?.eventsByType[event.type]?.personal;
      return markedFields(marks ?? null, event.payload);
    }
    return markedFields(
      processes.byName[process]?.personal ?? null,
      lifecycleStateOf(event.payload),
    );
  };
  const commandMarks = (type: string): PersonalMarks | null =>
    aggregates.commandsByType[type]?.command.personal ?? null;
  // Each key read once a page, and let go with it.
  const opener = () => {
    const keyOf = sealedKeys(storage.personalKeys);
    return {
      openText: openTextWith(keyOf),
      openedData: async (type: string, payload: unknown): Promise<Marked> => {
        const opened = await openCommandPayload({ payload, keys: storage.personalKeys, keyOf });
        return markedFields(commandMarks(type), opened.payload);
      },
    };
  };
  // A letter's error text is the person's only when it is sealed under them: one listed for the
  // persons its payload names keeps whatever its own `person` holds.
  const exportedLetter = async (
    { openText, openedData }: ReturnType<typeof opener>,
    letter: StoredDeadLetter,
  ): Promise<ExportedDeadLetter> => {
    const theirs = letter.person === personId || letter.statePerson === personId;
    const data = await openedData(letter.eventType, letter.payload);
    return {
      id: letter.id,
      kind: letter.kind,
      handler: letter.handler,
      ...(theirs ? { errorMessage: await openText(letter.errorMessage) } : {}),
      ...(theirs && letter.errorStack !== undefined
        ? { errorStack: await openText(letter.errorStack) }
        : {}),
      ...data,
      restricted: [
        ...restrictedFields(data.categories),
        ...(theirs
          ? textRestricted.filter(
              (field) => field === "errorMessage" || letter.errorStack !== undefined,
            )
          : []),
      ],
    };
  };

  async function* parts(): AsyncGenerator<PersonalDataExportPart, void, undefined> {
    yield { kind: "header", header };
    let afterPosition = 0;
    let page: readonly StoredEvent[];
    do {
      page = await storage.eventStore.readByPerson({
        person: personId,
        afterPosition,
        limit: batchSize,
      });
      for (const event of page) {
        if (event.position > position) return yield* rest();
        const data = eventData(event);
        yield {
          kind: "event",
          event: {
            id: event.id,
            type: event.type,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            version: event.version,
            position: event.position,
            timestamp: event.timestamp,
            ...data,
            restricted: eventRestricted(event, data.categories),
            redacted: [...(redactedOf.get(event.id) ?? [])].filter((field) => field in data.data),
          },
        };
        afterPosition = event.position;
      }
    } while (page.length === batchSize);
    yield* rest();
  }

  async function* rest(): AsyncGenerator<PersonalDataExportPart, void, undefined> {
    for await (const entries of paged(
      (after) =>
        storage.scheduler.listByPerson({
          person: personId,
          after,
          limit: batchSize,
        }),
      ({ dedupeKey }) => dedupeKey,
    )) {
      const { openedData } = opener();
      for (const entry of entries) {
        const data = await openedData(entry.command.type, entry.command.payload);
        yield {
          kind: "scheduledCommand",
          scheduledCommand: {
            commandId: scheduledCommandId(entry.dedupeKey) ?? entry.dedupeKey,
            type: entry.command.type,
            executeAt: entry.executeAt,
            ...(entry.scheduledAt === undefined ? {} : { scheduledAt: entry.scheduledAt }),
            ...data,
            restricted: restrictedFields(data.categories),
          },
        };
      }
    }
    for await (const letters of paged(
      (after) =>
        storage.deadLetterStore.listByPerson({
          person: personId,
          after,
          limit: batchSize,
        }),
      ({ id }) => id,
    )) {
      const opening = opener();
      for (const letter of letters) {
        yield { kind: "deadLetter", deadLetter: await exportedLetter(opening, letter) };
      }
    }
    // One row per subscriber: few enough to read whole.
    const { openText } = opener();
    for (const failure of await storage.subscriberFailures.list()) {
      if (failure.person !== personId) continue;
      yield {
        kind: "subscriberFailure",
        subscriberFailure: {
          subscriber: failure.subscriber,
          eventId: failure.eventId,
          eventType: failure.eventType,
          errorMessage: await openText(failure.errorMessage),
          ...(failure.errorStack === undefined
            ? {}
            : { errorStack: await openText(failure.errorStack) }),
          restricted: textRestricted.filter(
            (field) => field === "errorMessage" || failure.errorStack !== undefined,
          ),
        },
      };
    }
    // An answer a key it is sealed under no longer opens holds nothing to hand out. One kept
    // before keys were filed by their HMAC holds no key of its own, and is filed under it in the
    // clear.
    const now = clock.now();
    for await (const records of paged(
      (after) =>
        storage.idempotencyStore.listByPerson({
          person: personId,
          now,
          after,
          limit: batchSize,
        }),
      ({ key }) => key,
    )) {
      for (const record of records) {
        const remembered =
          record.answer === null
            ? null
            : await openAnswer({
                keys: storage.personalKeys,
                atRest: storage.atRest,
                answer: record.answer,
              });
        if (remembered === null) continue;
        yield {
          kind: "answer",
          answer: {
            idempotencyKey: remembered.key ?? record.key,
            expiresAt: record.expiresAt,
            outcome: remembered.outcome,
            restricted: restrictions.length > 0 ? ["outcome"] : [],
          },
        };
      }
    }
    for (const { name, storage: rowsStorage, personalData, fields, layout } of Object.values(
      readModels.byName,
    )) {
      if (personalData === null) continue;
      yield* exportedRows(
        name,
        rowsStorage,
        personalData,
        { fields, layout },
        sealing,
        personId,
        batchSize,
        requestedFields,
      );
    }
    const after = await personStream(storage, personId);
    if (after.version !== before.version) {
      throw new PersonalDataChangedError(personId, before.version, after.version);
    }
  }

  return parts();
};

export interface ExportPersonalDataFunction {
  (args: StreamPersonalDataArgs): Promise<PersonalDataExport>;
}

export const exportPersonalData: ExportPersonalDataFunction = async (args) =>
  collectPersonalDataExport(await streamPersonalData(args));

export interface RecordedPartsFunction {
  (
    parts: AsyncIterable<PersonalDataExportPart>,
    record: (outcome: AccessOutcome, counts: ExportedCounts) => Promise<void>,
    onError: (error: unknown) => void,
  ): AsyncGenerator<PersonalDataExportPart, void, undefined>;
}

// Recorded however the reading ends, with what was handed out by then: whole, failed, or stopped
// by its reader. A record that fails rejects in place of the error, as `recorded` does.
export const recordedParts: RecordedPartsFunction = async function* (parts, record, onError) {
  let counts = NO_EXPORTED_RECORDS;
  let outcome: AccessOutcome = "cancelled";
  try {
    for await (const part of parts) {
      counts = countPart(counts, part);
      yield part;
    }
    outcome = "ok";
  } catch (error) {
    outcome = "failed";
    onError(error);
    throw error;
  } finally {
    await record(outcome, counts);
  }
};
