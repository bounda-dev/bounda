import type { Storage } from "../../adapter/adapter.ts";
import type { DeadLetterKind, StoredDeadLetter } from "../../adapter/storage/dead-letter-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { scheduledCommandId } from "../command/pipeline.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { openCommandPayload, sealedKeys } from "./commands.ts";
import { openTextWith } from "./errors.ts";
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

// Nothing is locked: the export holds what each store held as it was read.
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
  // Each person's key read once for the whole export.
  const keyOf = sealedKeys(storage.personalKeys);
  const openText = openTextWith(keyOf);
  const openedData = async (type: string, payload: unknown): Promise<ExportedData> => {
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
      data: letter.payload === undefined ? {} : await openedData(letter.eventType, letter.payload),
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
    (await storage.deadLetterStore.listByPerson(personId)).map(exportedLetter),
  );
  return { personId, exportedAt, events, scheduledCommands, deadLetters };
};
