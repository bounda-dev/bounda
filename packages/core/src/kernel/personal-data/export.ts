import type { Storage } from "../../adapter/adapter.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { scheduledCommandId } from "../command/pipeline.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { openCommandPayload } from "./commands.ts";
import type { PersonalMarks } from "./marks.ts";

/**
 * The marked fields of a stored payload, as a handler reads them: a field forgotten is `null`,
 * one the payload never had is left out.
 */
export type ExportedData = Readonly<Record<string, unknown>>;

/**
 * An event that names the person, with the personal fields it holds of them and nothing else of
 * its payload.
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
}

/**
 * A command waiting to run that holds personal fields of the person.
 */
export interface ExportedScheduledCommand {
  readonly commandId: string;
  readonly type: string;
  readonly executeAt: string;
  readonly data: ExportedData;
}

/**
 * The dead letter of a scheduled command that holds personal fields of the person.
 */
export interface ExportedDeadLetter {
  readonly id: string;
  readonly commandType: string;
  readonly data: ExportedData;
}

/**
 * What `exportPersonalData` answers: every record the runtime holds that names the person, with
 * the fields marked `personal` of theirs opened. Fields left unmarked are not personal data to
 * Bounda and stay out, as do read models and whatever left the store.
 */
export interface PersonalDataExport {
  readonly personId: string;
  /**
   * When the export was taken, on the app's clock.
   */
  readonly exportedAt: string;
  readonly events: readonly ExportedEvent[];
  readonly scheduledCommands: readonly ExportedScheduledCommand[];
  readonly deadLetters: readonly ExportedDeadLetter[];
}

export interface ExportPersonalDataArgs {
  /**
   * The app's storage, whose event store opens the fields and upcasts the payloads.
   */
  readonly storage: Storage;
  readonly aggregates: AggregatesRuntime;
  readonly clock: Clock;
  readonly batchSize: number;
  readonly personId: string;
}

export interface ExportPersonalDataFunction {
  (args: ExportPersonalDataArgs): Promise<PersonalDataExport>;
}

const markedFields = (marks: PersonalMarks | null, payload: unknown): ExportedData => {
  if (marks === null || !isRecord(payload)) return {};
  return Object.fromEntries(
    marks.fields
      .filter((field) => payload[field] !== undefined)
      .map((field) => [field, payload[field]]),
  );
};

/**
 * Gathers the person's events, read by `person` page by page, and the scheduled commands and dead
 * letters whose `persons` name them, each with only its marked fields. Nothing is locked: the
 * export is a snapshot of what each store held as it was read. Rejects with `ValidationError` an
 * empty id.
 */
export const exportPersonalData: ExportPersonalDataFunction = async ({
  storage,
  aggregates,
  clock,
  batchSize,
  personId,
}) => {
  if (typeof personId !== "string" || personId === "") {
    throw new ValidationError("exportPersonalData needs the id of the person to export", [
      { path: ["personId"], message: "Expected a non-empty string" },
    ]);
  }
  const exportedAt = clock.now().toISOString();
  const eventMarks = (event: StoredEvent): PersonalMarks | null =>
    aggregates.byName[event.aggregateType]?.eventsByType[event.type]?.personal ?? null;
  const commandMarks = (type: string): PersonalMarks | null =>
    aggregates.commandsByType[type]?.command.personal ?? null;
  const openedData = async (type: string, payload: unknown): Promise<ExportedData> => {
    const opened = await openCommandPayload({ payload, keys: storage.personalKeys });
    return markedFields(commandMarks(type), opened.payload);
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
        data: markedFields(eventMarks(event), event.payload),
      });
      afterPosition = event.position;
    }
  } while (page.length === batchSize);

  const scheduledCommands = await Promise.all(
    (await storage.scheduler.listByPerson(personId)).map(async (entry) => ({
      commandId: scheduledCommandId(entry.dedupeKey) ?? entry.dedupeKey,
      type: entry.command.type,
      executeAt: entry.executeAt,
      data: await openedData(entry.command.type, entry.command.payload),
    })),
  );
  const deadLetters = await Promise.all(
    (await storage.deadLetterStore.listByPerson(personId)).map(async (letter) => ({
      id: letter.id,
      commandType: letter.handler,
      data: await openedData(letter.eventType, letter.payload),
    })),
  );
  return { personId, exportedAt, events, scheduledCommands, deadLetters };
};
