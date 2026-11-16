import type { DeadLetterKind } from "../../adapter/storage/dead-letter-store.ts";
import type { DispatchOutcome } from "../../adapter/storage/idempotency-store.ts";
import type { ExportAccess } from "../../modules/audit.ts";
import type {
  AutomatedDecision,
  LegalBasis,
  PersonalDataSource,
  ProcessingRestriction,
} from "../../modules/personal-data.ts";
import type { PersonRecipient } from "../../modules/recipient.ts";

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
 * A category of the app as the export tells the person of it, as article 15(1) of the GDPR asks:
 * its `basis`, `null` for the default category, which declares none; its `purposes` (a) and
 * `sources` (g), none for the default category; and how long it is kept (d): its `retention`
 * after their last activity, `null` when nothing forgets it for inactivity, and, for them, until
 * when.
 */
export interface ExportedCategory {
  readonly basis: LegalBasis | null;
  readonly purposes: readonly string[];
  readonly sources: readonly PersonalDataSource[];
  readonly retention: string | null;
  /**
   * Whether the runtime holds data of theirs in it: a key of theirs, in force or kept.
   */
  readonly held: boolean;
  /**
   * When the retention forgets what they hold of it unless they are active again before, or
   * restricted then, which the retention waits on; `null` when it does not, or they hold none.
   */
  readonly keptUntil: string | null;
  /**
   * When what a forgetting kept of it under a legal obligation goes, unless they are restricted
   * then, as `keptUntil`; `null` when it kept nothing.
   */
  readonly restrictedUntil: string | null;
}

/**
 * A right of the person over their data, as the GDPR names them: `access` (article 15),
 * `rectification` (16), `erasure` (17), `restriction` (18), `portability` (20), `objection` (21),
 * `withdraw-consent` (7(3)), `human-intervention` in an automated decision (22(3)), and
 * `complaint` to a supervisory authority (77).
 */
export type PersonalDataRight =
  | "access"
  | "rectification"
  | "erasure"
  | "restriction"
  | "portability"
  | "objection"
  | "withdraw-consent"
  | "human-intervention"
  | "complaint";

/**
 * A right the person has, as article 15(1)(e) and (f) ask they be told, with its article and the
 * categories it reaches, from the basis each declares; `null` for every one of their data.
 */
export interface ExportedRight {
  readonly right: PersonalDataRight;
  readonly article: string;
  readonly categories: readonly string[] | null;
}

/**
 * An automated decision `app/personal-data.ts` declares on a category of theirs, as article
 * 15(1)(h) asks: the logic involved, its significance and the envisaged consequences for them.
 */
export interface ExportedAutomatedDecision extends AutomatedDecision {
  readonly name: string;
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
  /**
   * When it was scheduled; absent for one stored before Bounda recorded it.
   */
  readonly scheduledAt?: string;
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
 * A dispatch remembered under an idempotency key whose answer names the person, sealed under
 * their keys: what it answered, opened. It is remembered until `expiresAt`.
 */
export interface ExportedAnswer {
  readonly idempotencyKey: string;
  readonly expiresAt: string;
  readonly outcome: DispatchOutcome;
  /**
   * `["outcome"]` while any restriction of the person holds: the answer may quote any of their
   * data.
   */
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
   * The head of the stream when the export began: `events` holds those up to it.
   */
  readonly position: number;
  /**
   * Every category of the app, the default one included, by name.
   */
  readonly categories: Readonly<Record<string, ExportedCategory>>;
  /**
   * Their rights, each with the categories it reaches.
   */
  readonly rights: readonly ExportedRight[];
  /**
   * The automated decisions the app declares on a category they hold data of.
   */
  readonly automatedDecisions: readonly ExportedAutomatedDecision[];
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
  /**
   * The recipients of their data, or the categories of recipients, as article 15(1)(c) asks: each
   * port's recipient that was disclosed data of theirs, may hold it, or may receive it, with the
   * categories concerned and their basis, its country and the safeguard of a transfer out of the
   * European Economic Area. Each event of `bounda:<personId>` names in `recipients` whom it told.
   */
  readonly recipients: readonly PersonRecipient[];
  readonly events: readonly ExportedEvent[];
  readonly scheduledCommands: readonly ExportedScheduledCommand[];
  readonly deadLetters: readonly ExportedDeadLetter[];
  readonly subscriberFailures: readonly ExportedSubscriberFailure[];
  /**
   * What the commands dispatched with an idempotency key that concern the person answered, while
   * the runtime remembers it.
   */
  readonly answers: readonly ExportedAnswer[];
  /**
   * By read model, every one with a field marked `.person()`, rows or none.
   */
  readonly readModels: Readonly<Record<string, readonly ExportedRow[]>>;
}

/**
 * What a streamed export hands out before any record: everything of `PersonalDataExport` but its
 * records, and the read models whose rows follow, in the order they come.
 */
export interface PersonalDataExportHeader
  extends Pick<
    PersonalDataExport,
    | "personId"
    | "exportedAt"
    | "position"
    | "categories"
    | "rights"
    | "automatedDecisions"
    | "restrictions"
    | "redactions"
    | "recipients"
  > {
  readonly readModels: readonly string[];
}

/**
 * One piece of a streamed export: the header first, then each record, in the order and the
 * sections of `PersonalDataExport`: events, scheduled commands, dead letters, subscriber failures,
 * answers, and the rows of each read model, the header's `readModels` in turn.
 */
export type PersonalDataExportPart =
  | { readonly kind: "header"; readonly header: PersonalDataExportHeader }
  | { readonly kind: "event"; readonly event: ExportedEvent }
  | { readonly kind: "scheduledCommand"; readonly scheduledCommand: ExportedScheduledCommand }
  | { readonly kind: "deadLetter"; readonly deadLetter: ExportedDeadLetter }
  | { readonly kind: "subscriberFailure"; readonly subscriberFailure: ExportedSubscriberFailure }
  | { readonly kind: "answer"; readonly answer: ExportedAnswer }
  | { readonly kind: "row"; readonly readModel: string; readonly row: ExportedRow };

/**
 * How many records of each kind an export handed out.
 */
export type ExportedCounts = ExportAccess["detail"];

export interface CountPartFunction {
  (counts: ExportedCounts, part: PersonalDataExportPart): ExportedCounts;
}

export const NO_EXPORTED_RECORDS: ExportedCounts = {
  events: 0,
  scheduledCommands: 0,
  deadLetters: 0,
  subscriberFailures: 0,
  answers: 0,
  readModelRows: 0,
  recipients: 0,
};

export const countPart: CountPartFunction = (counts, part) => {
  switch (part.kind) {
    case "header":
      return { ...counts, recipients: part.header.recipients.length };
    case "event":
      return { ...counts, events: counts.events + 1 };
    case "scheduledCommand":
      return { ...counts, scheduledCommands: counts.scheduledCommands + 1 };
    case "deadLetter":
      return { ...counts, deadLetters: counts.deadLetters + 1 };
    case "subscriberFailure":
      return { ...counts, subscriberFailures: counts.subscriberFailures + 1 };
    case "answer":
      return { ...counts, answers: counts.answers + 1 };
    case "row":
      return { ...counts, readModelRows: counts.readModelRows + 1 };
  }
};

export interface CollectPersonalDataExportFunction {
  (parts: AsyncIterable<PersonalDataExportPart>): Promise<PersonalDataExport>;
}

export const collectPersonalDataExport: CollectPersonalDataExportFunction = async (parts) => {
  let header: PersonalDataExportHeader | undefined;
  const events: ExportedEvent[] = [];
  const scheduledCommands: ExportedScheduledCommand[] = [];
  const deadLetters: ExportedDeadLetter[] = [];
  const subscriberFailures: ExportedSubscriberFailure[] = [];
  const answers: ExportedAnswer[] = [];
  const rows = new Map<string, ExportedRow[]>();
  for await (const part of parts) {
    switch (part.kind) {
      case "header":
        if (header !== undefined) throw new Error("A personal data export has a second header");
        header = part.header;
        for (const name of part.header.readModels) rows.set(name, []);
        break;
      case "event":
        events.push(part.event);
        break;
      case "scheduledCommand":
        scheduledCommands.push(part.scheduledCommand);
        break;
      case "deadLetter":
        deadLetters.push(part.deadLetter);
        break;
      case "subscriberFailure":
        subscriberFailures.push(part.subscriberFailure);
        break;
      case "answer":
        answers.push(part.answer);
        break;
      case "row": {
        const of = rows.get(part.readModel);
        if (of === undefined) {
          throw new Error(
            `A personal data export has a row of ${part.readModel}, which its header does not name`,
          );
        }
        of.push(part.row);
        break;
      }
    }
  }
  if (header === undefined) throw new Error("A personal data export ended before its header");
  const { readModels: _names, ...rest } = header;
  return {
    ...rest,
    events,
    scheduledCommands,
    deadLetters,
    subscriberFailures,
    answers,
    readModels: Object.fromEntries(rows),
  };
};
