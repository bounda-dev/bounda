import type { ReadModelStorage } from "../../adapter/adapter.ts";
import type { StoredDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import { DEFAULT_PERSONAL_CATEGORY } from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { ExportOutcome } from "../../modules/audit.ts";
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
import type { PersonalCategories } from "./categories.ts";
import { openCommandPayload, sealedKeys } from "./commands.ts";
import { type OpenTextFunction, openTextWith } from "./errors.ts";
import { openedUnder, redactedIn } from "./event-store.ts";
import {
  collectPersonalDataExport,
  countPart,
  type ExportedCategories,
  type ExportedCounts,
  type ExportedData,
  type ExportedDeadLetter,
  type ExportedRedaction,
  type ExportedRestricted,
  type ExportedWithheld,
  NO_EXPORTED_RECORDS,
  type PersonalDataExport,
  type PersonalDataExportHeader,
  type PersonalDataExportPart,
  type PersonalDataExportRecord,
} from "./export.ts";
import { personalDataInformation } from "./information.ts";
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
  /**
   * Whether what article 15(4) holds back is opened, still marked.
   */
  readonly includeWithheld: boolean;
}

// The header, read whole, and every record, each read only as it is asked for.
export interface StreamedExport {
  readonly header: PersonalDataExportHeader;
  readonly records: AsyncGenerator<PersonalDataExportRecord, void, undefined>;
  // Everyone else whose data the values opened in spite of article 15(4) may quote, so far.
  readonly others: () => readonly string[];
}

export interface StreamPersonalDataFunction {
  (args: StreamPersonalDataArgs): Promise<StreamedExport>;
}

interface Marked {
  readonly data: ExportedData;
  readonly categories: ExportedCategories;
}

const WITHHELD_FOR_OTHERS = { reason: "rights-of-others", article: "15(4)" } as const;

const TEXT_FIELDS = ["errorMessage", "errorStack"] as const;

const ANSWER_FIELDS = ["idempotencyKey", "outcome"] as const;

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
): AsyncGenerator<PersonalDataExportRecord & { readonly kind: "row" }, void, undefined> {
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

// The version of the person's own stream, whose events are the runtime's about them: read alone,
// however many they are.
const personVersion = async (storage: AppStorage, personId: string): Promise<number> =>
  (
    await storage.eventStore.load({
      aggregateType: BOUNDA_AGGREGATE,
      aggregateId: personId,
      fromVersion: Number.MAX_SAFE_INTEGER,
    })
  ).version;

// The redactions of the person's own stream up to `version`, a window of it at a time.
async function* exportedRedactions(
  storage: AppStorage,
  personId: string,
  version: number,
  batchSize: number,
): AsyncGenerator<PersonalDataExportRecord & { readonly kind: "redaction" }, void, undefined> {
  for (let from = 1; from <= version; from += batchSize) {
    const { events } = await storage.eventStore.load({
      aggregateType: BOUNDA_AGGREGATE,
      aggregateId: personId,
      fromVersion: from,
      toVersion: Math.min(from + batchSize - 1, version),
    });
    for (const event of events) {
      if (event.type !== PERSONAL_DATA_REDACTED_EVENT) continue;
      const redaction: ExportedRedaction = {
        eventId: event.id,
        at: event.timestamp,
        events: (event.payload as PersonalDataRedactedPayload).events.map(({ id, fields }) => ({
          id,
          fields,
        })),
      };
      yield { kind: "redaction", redaction };
    }
  }
}

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
  includeWithheld,
}) => {
  checkPersonId(personId, "exportPersonalData");
  const exportedAt = clock.now().toISOString();
  // The person's stream before the head: whatever it gains after this, the end finds.
  const before = await personVersion(storage, personId);
  const position = await storage.eventStore.lastPosition();
  const restrictions = processingRestrictionsOf(await storage.persons.restrictions(personId));
  const information = personalDataInformation({
    categories,
    keys: await storage.personalKeys.list(personId),
    person: await storage.persons.get(personId),
  });
  const exportedCategories = information.categories;
  const header: PersonalDataExportHeader = {
    personId,
    exportedAt,
    position,
    ...information,
    restrictions,
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
  // Everyone else whose data a value opened in spite of article 15(4) may quote.
  const others = new Set<string>();
  // What of a value sealed under `sealedUnder` the person gets, as `fields`: all of it when it is
  // sealed under them alone; when it is sealed under someone else too, it may quote their data, so
  // it is held back, reading `null`, unless `includeWithheld` opens it. A value no key opens any
  // more holds nothing to hold back.
  const shared = <Opened extends Record<string, unknown>>(
    sealedUnder: readonly string[],
    opened: Opened,
    fields: readonly (keyof Opened & string)[],
  ): {
    readonly values: { readonly [Field in keyof Opened]: Opened[Field] | null };
    readonly withheld: readonly ExportedWithheld[];
  } => {
    const elsewhere = sealedUnder.filter((person) => person !== personId);
    const held = fields.filter((field) => opened[field] !== null);
    if (elsewhere.length === 0 || held.length === 0) return { values: opened, withheld: [] };
    const withheld = held.map((field) => ({ field, ...WITHHELD_FOR_OTHERS }));
    if (includeWithheld) {
      for (const person of elsewhere) others.add(person);
      return { values: opened, withheld };
    }
    return {
      values: { ...opened, ...Object.fromEntries(held.map((field) => [field, null])) },
      withheld,
    };
  };
  // An error's text, opened, as the person gets it.
  const exportedText = async (
    openText: OpenTextFunction,
    sealedUnder: readonly string[],
    { errorMessage, errorStack }: Pick<StoredDeadLetter, "errorMessage" | "errorStack">,
  ) => {
    const opened = {
      errorMessage: await openText(errorMessage),
      ...(errorStack === undefined ? {} : { errorStack: await openText(errorStack) }),
    };
    return shared(sealedUnder, opened, errorStack === undefined ? ["errorMessage"] : TEXT_FIELDS);
  };
  // A letter's error text is the person's only when it is sealed under them: one listed for the
  // persons its payload names keeps whatever its own `person` holds.
  const exportedLetter = async (
    { openText, openedData }: ReturnType<typeof opener>,
    letter: StoredDeadLetter,
  ): Promise<ExportedDeadLetter> => {
    const sealedUnder = [
      ...(letter.person === null ? [] : [letter.person]),
      ...(letter.statePerson === undefined ? [] : [letter.statePerson]),
      ...(letter.readPersons ?? []),
    ];
    const theirs = sealedUnder.includes(personId);
    const text = theirs ? await exportedText(openText, sealedUnder, letter) : null;
    const data = await openedData(letter.eventType, letter.payload);
    return {
      id: letter.id,
      kind: letter.kind,
      handler: letter.handler,
      ...text?.values,
      ...data,
      restricted: [
        ...restrictedFields(data.categories),
        ...(theirs
          ? textRestricted.filter(
              (field) => field === "errorMessage" || letter.errorStack !== undefined,
            )
          : []),
      ],
      withheld: text?.withheld ?? [],
    };
  };

  async function* records(): AsyncGenerator<PersonalDataExportRecord, void, undefined> {
    yield* exportedRedactions(storage, personId, before, batchSize);
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
            redacted: redactedIn(event).filter((field) => field in data.data),
          },
        };
        afterPosition = event.position;
      }
    } while (page.length === batchSize);
    yield* rest();
  }

  async function* rest(): AsyncGenerator<PersonalDataExportRecord, void, undefined> {
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
      const sealedUnder = [
        ...(failure.person === null ? [] : [failure.person]),
        ...(failure.readPersons ?? []),
      ];
      if (!sealedUnder.includes(personId)) continue;
      const text = await exportedText(openText, sealedUnder, failure);
      yield {
        kind: "subscriberFailure",
        subscriberFailure: {
          subscriber: failure.subscriber,
          eventId: failure.eventId,
          eventType: failure.eventType,
          errorMessage: text.values.errorMessage,
          ...(text.values.errorStack === undefined ? {} : { errorStack: text.values.errorStack }),
          restricted: textRestricted.filter(
            (field) => field === "errorMessage" || failure.errorStack !== undefined,
          ),
          withheld: text.withheld,
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
        const { values, withheld } = shared(
          record.persons.map(({ person }) => person),
          { idempotencyKey: remembered.key ?? record.key, outcome: remembered.outcome },
          ANSWER_FIELDS,
        );
        yield {
          kind: "answer",
          answer: {
            idempotencyKey: values.idempotencyKey,
            expiresAt: record.expiresAt,
            outcome: values.outcome,
            restricted: restrictions.length > 0 ? ["outcome"] : [],
            withheld,
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
    const after = await personVersion(storage, personId);
    if (after !== before) throw new PersonalDataChangedError(personId, before, after);
  }

  return { header, records: records(), others: () => [...others] };
};

async function* exportParts({
  header,
  records,
}: StreamedExport): AsyncGenerator<PersonalDataExportPart, void, undefined> {
  yield { kind: "header", header };
  yield* records;
}

export interface ExportPersonalDataFunction {
  (args: StreamPersonalDataArgs): Promise<PersonalDataExport>;
}

export const exportPersonalData: ExportPersonalDataFunction = async (args) =>
  collectPersonalDataExport(exportParts(await streamPersonalData(args)));

export interface RecordedExportArgs {
  readonly streamed: StreamedExport;
  readonly record: (outcome: ExportOutcome, counts: ExportedCounts) => Promise<void>;
  readonly onError: (error: unknown) => void;
}

export interface RecordedExportFunction {
  (args: RecordedExportArgs): Promise<AsyncGenerator<PersonalDataExportPart, void, undefined>>;
}

async function* ended(
  { streamed: { header, records }, record, onError }: RecordedExportArgs,
  started: ExportedCounts,
): AsyncGenerator<PersonalDataExportPart, void, undefined> {
  let counts = started;
  let outcome: ExportOutcome = "cancelled";
  try {
    yield { kind: "header", header };
    for await (const part of records) {
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
}

// Recorded `started` before the header is handed out, so an export its reader leaves unread, or
// whose process dies, is recorded all the same; then however the reading ends, with what was
// handed out by then: whole, failed, or stopped by its reader. A record that fails rejects in place
// of what it records, as `recorded` does.
export const recordedExport: RecordedExportFunction = async (args) => {
  const started = countPart(NO_EXPORTED_RECORDS, { kind: "header", header: args.streamed.header });
  await args.record("started", started);
  return ended(args, started);
};
