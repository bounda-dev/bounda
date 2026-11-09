import type { ReadModelStorage } from "../../adapter/adapter.ts";
import type { DeadLetterKind, StoredDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import { DEFAULT_PERSONAL_CATEGORY } from "../../adapter/storage/personal-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { retentionEnd } from "../../contracts/duration.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { LegalBasis } from "../../modules/personal-data.ts";
import type { FieldsRecord } from "../../modules/view.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { scheduledCommandId } from "../command/pipeline.ts";
import type { AppStorage } from "../events/app-event-store.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { processOfStream } from "../process/lifecycle.ts";
import type { ReadModelPersonalData, ReadModelsRuntime } from "../read-model/build-read-models.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { formatRetention, type PersonalCategories } from "./categories.ts";
import { openCommandPayload, sealedKeys } from "./commands.ts";
import { openTextWith } from "./errors.ts";
import { fieldCategory, type PersonalMarks } from "./marks.ts";
import { lifecycleStateOf } from "./process-state.ts";
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
}

/**
 * A row of a read model whose field marked `.person()` names the person: its primary key, which
 * tells it apart, and its fields marked `.personal()`, a field the row does not have left out.
 */
export interface ExportedRow {
  readonly key: unknown;
  readonly data: ExportedData;
  readonly categories: ExportedCategories;
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
  readonly events: readonly ExportedEvent[];
  readonly scheduledCommands: readonly ExportedScheduledCommand[];
  readonly deadLetters: readonly ExportedDeadLetter[];
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
  fields: FieldsRecord,
  personId: string,
  batchSize: number,
): Promise<readonly ExportedRow[]> => {
  const rows: ExportedRow[] = [];
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
    for (const row of page) {
      const held = personal.filter((field) => row[field] !== undefined);
      rows.push({
        key: row[primaryKey],
        data: Object.fromEntries(held.map((field) => [field, row[field]])),
        categories: Object.fromEntries(
          held.map((field) => [field, fields[field]?.category ?? DEFAULT_PERSONAL_CATEGORY]),
        ),
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
  clock,
  batchSize,
  categories,
  personId,
}) => {
  checkPersonId(personId, "exportPersonalData");
  const exportedAt = clock.now().toISOString();
  // Independent of the store's records, and often on another adapter, so read meanwhile; a
  // failure of the store's reads first leaves this one handled, the export rejecting with that.
  const rows = Promise.all(
    Object.values(readModels.byName).flatMap(
      ({ name, storage: rowsStorage, personalData, fields }) =>
        personalData === null
          ? []
          : [
              exportedRows(rowsStorage, personalData, fields, personId, batchSize).then(
                (exported) => [name, exported] as const,
              ),
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
    return {
      id: letter.id,
      kind: letter.kind,
      handler: letter.handler,
      ...(theirs ? { errorMessage: await openText(letter.errorMessage) } : {}),
      ...(theirs && letter.errorStack !== undefined
        ? { errorStack: await openText(letter.errorStack) }
        : {}),
      ...(await openedData(letter.eventType, letter.payload)),
    };
  };

  const events: ExportedEvent[] = [];
  let afterPosition = 0;
  let page: readonly StoredEvent[];
  do {
    page = await storage.eventStore.readByPerson({
      person: personId,
      afterPosition,
      limit: batchSize,
    });
    for (const event of page) {
      events.push({
        id: event.id,
        type: event.type,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        version: event.version,
        position: event.position,
        timestamp: event.timestamp,
        ...eventData(event),
      });
      afterPosition = event.position;
    }
  } while (page.length === batchSize);

  const scheduledCommands = await Promise.all(
    (await storage.scheduler.listByPerson(personId)).map(async (entry) => ({
      commandId: scheduledCommandId(entry.dedupeKey) ?? entry.dedupeKey,
      type: entry.command.type,
      executeAt: entry.executeAt,
      ...(await openedData(entry.command.type, entry.command.payload)),
    })),
  );
  const deadLetters = await Promise.all(
    (await storage.deadLetterStore.listByPerson(personId)).map(exportedLetter),
  );
  return {
    personId,
    exportedAt,
    categories: await categoriesOf(storage, categories, personId),
    events,
    scheduledCommands,
    deadLetters,
    readModels: Object.fromEntries(await rows),
  };
};
