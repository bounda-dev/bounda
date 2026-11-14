import type { ReadModelStorage } from "../../adapter/adapter.ts";
import type { DeadLetterKind, StoredDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import { DEFAULT_PERSONAL_CATEGORY } from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { retentionEnd } from "../../contracts/duration.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import {
  BOUNDA_AGGREGATE,
  PERSONAL_DATA_REDACTED_EVENT,
  type PersonalDataRedactedPayload,
} from "../../modules/bounda-events.ts";
import type { LegalBasis, ProcessingRestriction } from "../../modules/personal-data.ts";
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
import { createSealingKeyRing, type SealingKeyRing } from "../read-model/sealing-keys.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { formatRetention, type PersonalCategories } from "./categories.ts";
import { openCommandPayload, sealedKeys } from "./commands.ts";
import { openTextWith } from "./errors.ts";
import { openedUnder } from "./event-store.ts";
import { fieldCategory, type PersonalMarks } from "./marks.ts";
import { lifecycleStateOf } from "./process-state.ts";
import { processingRestrictionsOf } from "./restriction.ts";
import { checkPersonId } from "./transact.ts";

/**
 * The marked fields of a stored payload, as a handler reads them: a field forgotten is `null`,
 * one the payload never had is left out.
 */
export type ExportedData = Readonly<Record<string, unknown>>;

/**
 * The category of each field of `data`, by field, which the export's `categories` describes.
 */
export type ExportedCategories = Readonly<Record<string, string>>;

/**
 * What of a record a restriction covers, so the person sees what is only kept (article 15 still
 * hands it out): the fields of `data` by name, of a category restricted, or kept under a legal
 * obligation, or every one for a person restricted as a whole; and `errorMessage` and
 * `errorStack` for an error's text, which may quote any of their data, while any restriction
 * holds.
 */
export type ExportedRestricted = readonly string[];

/**
 * A category of the app as the export tells the person of it (article 15(1) of the GDPR): why it
 * is processed, `null` for the default category, which declares no basis, and for how long after
 * their last activity it is kept, `null` when nothing forgets it for inactivity. `restrictedUntil`
 * is when what a forgetting kept of it under a legal obligation goes, `null` when it kept nothing.
 */
export interface ExportedCategory {
  readonly basis: LegalBasis | null;
  readonly retention: string | null;
  readonly restrictedUntil: string | null;
}

/**
 * An event that names the person, with the personal fields it holds of them and nothing else of
 * its payload: for a process's lifecycle event, those of the state it carries.
 */
export interface ExportedEvent {
  readonly id: string;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly position: number;
  readonly timestamp: string;
  readonly data: ExportedData;
  readonly categories: ExportedCategories;
  readonly restricted: ExportedRestricted;
  /**
   * The fields of `data` a redaction sealed for good: they read `null`, and their old value is
   * nowhere to hand out.
   */
  readonly redacted: readonly string[];
}

/**
 * A redaction of the person's data (article 16): when it was made, by its `PersonalDataRedacted`,
 * and the events and fields it sealed for good, never a value.
 */
export interface ExportedRedaction {
  readonly eventId: string;
  readonly at: string;
  readonly events: readonly { readonly id: string; readonly fields: readonly string[] }[];
}

/**
 * A command waiting to run that holds personal fields of the person.
 */
export interface ExportedScheduledCommand {
  readonly commandId: string;
  readonly type: string;
  readonly executeAt: string;
  readonly data: ExportedData;
  readonly categories: ExportedCategories;
  readonly restricted: ExportedRestricted;
}

/**
 * A handler run that gave up and names the person: the work was about them, so the error's text is
 * sealed under their key, or it is a scheduled command whose payload holds personal fields of
 * theirs. `data` holds that payload's marked fields, empty for a policy or process letter.
 */
export interface ExportedDeadLetter {
  readonly id: string;
  readonly kind: DeadLetterKind;
  /**
   * The policy or process name, or the scheduled command's type.
   */
  readonly handler: string;
  /**
   * The error's message, opened, when it is sealed under the person; `null` once they are
   * forgotten.
   */
  readonly errorMessage?: string | null;
  /**
   * The error's stack, as `errorMessage` is, when it has one.
   */
  readonly errorStack?: string | null;
  readonly data: ExportedData;
  readonly categories: ExportedCategories;
  readonly restricted: ExportedRestricted;
}

/**
 * The last failure of a subscriber on an event that names the person, whose error text is sealed
 * under their key: opened, `null` once they are forgotten.
 */
export interface ExportedSubscriberFailure {
  readonly subscriber: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly errorMessage: string | null;
  readonly errorStack?: string | null;
  readonly restricted: ExportedRestricted;
}

/**
 * A row of a read model whose field marked `.person()` names the person: its primary key, which
 * tells it apart, and its fields marked `.personal()`, a field the row does not have left out.
 */
export interface ExportedRow {
  readonly key: unknown;
  readonly data: ExportedData;
  readonly categories: ExportedCategories;
  readonly restricted: ExportedRestricted;
}

/**
 * What `exportPersonalData` answers: every record the runtime holds that names the person, with
 * the fields marked `personal` of theirs opened, and the rows of every read model with a field
 * marked `.person()` that name them. Fields left unmarked are not personal data to Bounda and stay
 * out, as do the rows of read models without such a field and whatever left the store.
 */
export interface PersonalDataExport {
  readonly personId: string;
  /**
   * When the export was taken, on the app's clock.
   */
  readonly exportedAt: string;
  /**
   * Every category of the app, the default one included, by name.
   */
  readonly categories: Readonly<Record<string, ExportedCategory>>;
  /**
   * The restrictions the person asked for and has not had lifted, by ground; a lift announced is
   * in `events`, as `ProcessingRestrictionLiftAnnounced` with when it comes.
   */
  readonly restrictions: readonly ProcessingRestriction[];
  /**
   * The redactions of the person's data, in the order they were made; each event they reached says
   * which of its fields in `redacted`.
   */
  readonly redactions: readonly ExportedRedaction[];
  readonly events: readonly ExportedEvent[];
  readonly scheduledCommands: readonly ExportedScheduledCommand[];
  readonly deadLetters: readonly ExportedDeadLetter[];
  readonly subscriberFailures: readonly ExportedSubscriberFailure[];
  /**
   * By read model, every one with a field marked `.person()`, rows or none.
   */
  readonly readModels: Readonly<Record<string, readonly ExportedRow[]>>;
}

export interface ExportPersonalDataArgs {
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
  readonly batchSize: number;
  readonly categories: PersonalCategories;
  readonly personId: string;
}

export interface ExportPersonalDataFunction {
  (args: ExportPersonalDataArgs): Promise<PersonalDataExport>;
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

// Each read model through its own storage, which may be another adapter's. Paged by primary key
// rather than by offset, so a row a projection writes or deletes meanwhile cannot make another one
// skip a page or repeat.
const exportedRows = async (
  storage: ReadModelStorage,
  { person, personal, primaryKey }: ReadModelPersonalData,
  { fields, layout }: Pick<ReadModelRuntime, "fields" | "layout">,
  keys: SealingKeyRing,
  personId: string,
  batchSize: number,
  restricted: (categories: ExportedCategories) => ExportedRestricted,
): Promise<readonly ExportedRow[]> => {
  const rows: ExportedRow[] = [];
  await keys.fetch([personId]);
  let page: readonly Record<string, unknown>[];
  let after: unknown;
  do {
    page = await storage.table.findMany({
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
      rows.push({
        key: row[primaryKey],
        data: Object.fromEntries(held.map((field) => [field, row[field]])),
        categories,
        restricted: [
          ...new Set([
            ...restricted(categories),
            ...retainedFields.filter((field) => held.includes(field)),
          ]),
        ],
      });
    }
    after = page.at(-1)?.[primaryKey];
    // A person field that is the primary key names one row at most, and a range on it would
    // take the place of the person's own value.
  } while (page.length === batchSize && person !== primaryKey);
  return rows;
};

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

// Nothing is locked: the export holds what each store held as it was read.
export const exportPersonalData: ExportPersonalDataFunction = async ({
  storage,
  aggregates,
  processes,
  readModels,
  sealing,
  clock,
  batchSize,
  categories,
  personId,
}) => {
  checkPersonId(personId, "exportPersonalData");
  const exportedAt = clock.now().toISOString();
  const restrictions = processingRestrictionsOf(await storage.persons.restrictions(personId));
  const exportedCategories = await categoriesOf(storage, categories, personId);
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
  // An event says the keys it was opened under: what a forgetting kept is restricted only when one
  // of them is a key it kept, so what the person wrote after they came back is not.
  const eventRestricted = (event: StoredEvent, of: ExportedCategories): ExportedRestricted =>
    openedUnder(event).some(({ person, retained }) => person === personId && retained === true)
      ? restrictedFields(of)
      : requestedFields(of);
  const textRestricted: ExportedRestricted =
    restrictions.length > 0 ? ["errorMessage", "errorStack"] : [];
  // Independent of the store's records, and often on another adapter, so read meanwhile; a
  // failure of the store's reads first leaves this one handled, the export rejecting with that.
  const rows = Promise.all(
    Object.values(readModels.byName).flatMap(
      ({ name, storage: rowsStorage, personalData, fields, layout }) =>
        personalData === null
          ? []
          : [
              exportedRows(
                rowsStorage,
                personalData,
                { fields, layout },
                createSealingKeyRing({ keys: sealing.keys, fetching: true }),
                personId,
                batchSize,
                requestedFields,
              ).then((exported) => [name, exported] as const),
            ],
    ),
  );
  rows.catch(() => undefined);
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
  // Each person's key read once for the whole export.
  const keyOf = sealedKeys(storage.personalKeys);
  const openText = openTextWith(keyOf);
  const openedData = async (type: string, payload: unknown): Promise<Marked> => {
    const opened = await openCommandPayload({ payload, keys: storage.personalKeys, keyOf });
    return markedFields(commandMarks(type), opened.payload);
  };
  // A letter's error text is the person's only when it is sealed under them: one listed for the
  // persons its payload names keeps whatever its own `person` holds.
  const exportedLetter = async (letter: StoredDeadLetter): Promise<ExportedDeadLetter> => {
    const theirs = letter.person === personId;
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

  const events: Omit<ExportedEvent, "redacted">[] = [];
  const redactions: ExportedRedaction[] = [];
  let afterPosition = 0;
  let page: readonly StoredEvent[];
  do {
    page = await storage.eventStore.readByPerson({
      person: personId,
      afterPosition,
      limit: batchSize,
    });
    for (const event of page) {
      const data = eventData(event);
      events.push({
        id: event.id,
        type: event.type,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        version: event.version,
        position: event.position,
        timestamp: event.timestamp,
        ...data,
        restricted: eventRestricted(event, data.categories),
      });
      if (event.aggregateType === BOUNDA_AGGREGATE && event.type === PERSONAL_DATA_REDACTED_EVENT) {
        const { events: reached } = event.payload as PersonalDataRedactedPayload;
        redactions.push({
          eventId: event.id,
          at: event.timestamp,
          events: reached.map(({ id, fields }) => ({ id, fields })),
        });
      }
      afterPosition = event.position;
    }
  } while (page.length === batchSize);

  const scheduledCommands = await Promise.all(
    (await storage.scheduler.listByPerson(personId)).map(async (entry) => {
      const data = await openedData(entry.command.type, entry.command.payload);
      return {
        commandId: scheduledCommandId(entry.dedupeKey) ?? entry.dedupeKey,
        type: entry.command.type,
        executeAt: entry.executeAt,
        ...data,
        restricted: restrictedFields(data.categories),
      };
    }),
  );
  const deadLetters = await Promise.all(
    (await storage.deadLetterStore.listByPerson(personId)).map(exportedLetter),
  );
  // One row per subscriber: few enough to read whole.
  const subscriberFailures = await Promise.all(
    (await storage.subscriberFailures.list())
      .filter((failure) => failure.person === personId)
      .map(async (failure) => ({
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
      })),
  );
  const redactedOf = new Map<string, Set<string>>();
  for (const redaction of redactions) {
    for (const { id, fields } of redaction.events) {
      redactedOf.set(id, new Set([...(redactedOf.get(id) ?? []), ...fields]));
    }
  }
  return {
    personId,
    exportedAt,
    categories: exportedCategories,
    restrictions,
    redactions,
    events: events.map((event) => ({
      ...event,
      redacted: [...(redactedOf.get(event.id) ?? [])].filter((field) => field in event.data),
    })),
    scheduledCommands,
    deadLetters,
    subscriberFailures,
    readModels: Object.fromEntries(await rows),
  };
};
