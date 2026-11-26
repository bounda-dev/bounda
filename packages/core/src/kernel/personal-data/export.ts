import type { DeadLetterKind } from "../../adapter/storage/dead-letter-store.ts";
import type { DispatchOutcome } from "../../adapter/storage/idempotency-store.ts";
import type { ExportAccess } from "../../modules/audit.ts";
import type { DataLocation, LegalRegime } from "../../modules/data-location.ts";
import type {
  AutomatedDecision,
  CriminalOffenceData,
  ErasureExemption,
  LegalBasis,
  PersonalDataSource,
  ProcessingRestriction,
  SpecialCategoryData,
  SpecificPurpose,
} from "../../modules/personal-data.ts";
import type { PersonRecipient, StoreSafeguard } from "../../modules/recipient.ts";

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
 * hands it out): the fields of `data` by name, of a category restricted, or kept under an erasure
 * exemption, or every one for a person restricted as a whole; and `errorMessage` and
 * `errorStack` for an error's text, which may quote any of their data, while any restriction
 * holds. With `includeWithheld`, also each value it opened that is sealed under someone else
 * whose processing is restricted.
 */
export type ExportedRestricted = readonly string[];

/**
 * Why the export holds a value of a record back: `rights-of-others`, as article 15(4) of the GDPR
 * asks, since the value is text the app's code wrote while it read data of someone else besides
 * the person, and may quote it.
 */
export type WithholdingReason = "rights-of-others";

/**
 * A value of a record the export holds back, which reads `null`, unless the export was asked for
 * with `includeWithheld`: the field, why, and the article that asks for it.
 */
export interface ExportedWithheld {
  readonly field: string;
  readonly reason: WithholdingReason;
  readonly article: string;
}

/**
 * What a reader of `exportPersonalData` or `streamPersonalData` may ask of the export.
 */
export interface PersonalDataExportOptions {
  /**
   * Opens what the export holds back under article 15(4), each value still named in its record's
   * `withheld`, for the controller to weigh whether handing it over would adversely affect the
   * other person before it does; the access log names those persons too. Never for an export
   * handed to the person as it is. Defaults to `false`.
   */
  readonly includeWithheld?: boolean;
}

/**
 * An exemption of article 17(3) that keeps a category past a forgetting, with its point:
 * `legal-obligation` and `public-task` 17(3)(b), `public-health` (c),
 * `archiving-research-or-statistics` (d), `legal-claims` (e).
 */
export interface ExportedErasureExemption {
  readonly exemption: ErasureExemption;
  readonly article: string;
}

export const EXEMPTION_ARTICLES: Readonly<Record<ErasureExemption, string>> = {
  "legal-obligation": "17(3)(b)",
  "public-task": "17(3)(b)",
  "public-health": "17(3)(c)",
  "archiving-research-or-statistics": "17(3)(d)",
  "legal-claims": "17(3)(e)",
};

/**
 * A category of the app as the export tells the person of it, as article 15(1) of the GDPR asks:
 * its `basis`, `null` for the default category, which declares none; the special categories of
 * data it holds and their condition of article 9(2) (`special`), and the authority it processes
 * criminal data under, article 10 (`criminal`), each `null` when it holds none; its `purposes` (a),
 * those among them the GDPR has rules of its own for (`processedFor`), and its `sources` (g), none
 * for the default category; the exemptions of article 17(3) that keep it past their erasure,
 * none when erasure reaches it; and how long it is kept (d): its `retention` after their last
 * activity, `null` when nothing forgets it for inactivity, and, for them, until when.
 */
export interface ExportedCategory {
  readonly basis: LegalBasis | null;
  readonly special: SpecialCategoryData | null;
  readonly criminal: CriminalOffenceData | null;
  readonly purposes: readonly string[];
  readonly processedFor: readonly SpecificPurpose[];
  readonly erasureExemptions: readonly ExportedErasureExemption[];
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
   * When what a forgetting kept of it under an erasure exemption goes, unless they are restricted
   * then, as `keptUntil`; `null` when it kept nothing.
   */
  readonly restrictedUntil: string | null;
}

/**
 * A right of the person over their data, as the GDPR names them: `access` (article 15),
 * `rectification` (16), `erasure` (17), `restriction` (18), `portability` (20), `objection` on
 * grounds of their particular situation (21(1)), `objection-to-direct-marketing`, at any time and
 * with nothing weighed (21(2)), `objection-to-research-or-statistics` (21(6)),
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
  | "objection-to-direct-marketing"
  | "objection-to-research-or-statistics"
  | "withdraw-consent"
  | "human-intervention"
  | "complaint";

/**
 * A store the app keeps under another legal regime than `storage`'s under a safeguard, as article 15(2)
 * asks the person be told of: `read-model`, the rows of the read model `readModel`, which holds
 * personal data; `master-key`, the key every tenant's key is wrapped under; `tenant-keys`, the
 * tenant's key, which every key of the person is wrapped under; `forget-ledger`, the record of
 * whom the app forgot or disclosed data of, by id.
 */
export interface ExportedTransfer {
  readonly store: "read-model" | "master-key" | "tenant-keys" | "forget-ledger";
  /**
   * `null` unless `store` is `read-model`.
   */
  readonly readModel: string | null;
  readonly location: DataLocation;
  readonly safeguard: StoreSafeguard;
  /**
   * The article of the GDPR the safeguard rests on.
   */
  readonly article: string;
  /**
   * The legal regime the store is under, as `regimeOf` names `location`.
   */
  readonly regime: LegalRegime;
}

/**
 * A right the person has, as article 15(1)(e) and (f) ask they be told, with its article and the
 * categories it reaches, from the basis each declares, and the condition of article 9(2) and the
 * purposes where they change them: special categories of data on `explicit-consent` can be
 * withdrawn and are portable, whatever the basis; erasure leaves out what an exemption of article
 * 17(3) keeps; direct marketing and research or statistics can be objected to; `null` for every
 * one of their data.
 */
export interface ExportedRight {
  readonly right: PersonalDataRight;
  readonly article: string;
  readonly categories: readonly string[] | null;
}

/**
 * An automated decision `app/personal-data.ts` declares on a category of theirs, as article
 * 15(1)(h) asks: the logic involved, its significance and the envisaged consequences for them, and,
 * on special categories of data, the measures that safeguard them (article 22(4)).
 */
export interface ExportedAutomatedDecision extends AutomatedDecision<string> {
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
 * A handler run that gave up and names the person: the work was about them or read their data, so
 * the error's text is sealed under their keys, or it is a scheduled command whose payload holds
 * personal fields of theirs. `data` holds that payload's marked fields, empty for a policy or
 * process letter.
 */
export interface ExportedDeadLetter {
  readonly id: string;
  readonly kind: DeadLetterKind;
  /**
   * The policy or process name, or the scheduled command's type.
   */
  readonly handler: string;
  /**
   * The error's message, opened, when it is sealed under the person; `null` once anyone it is
   * sealed under is forgotten, or when it is withheld.
   */
  readonly errorMessage?: string | null;
  /**
   * The error's stack, as `errorMessage` is, when it has one.
   */
  readonly errorStack?: string | null;
  readonly data: ExportedData;
  readonly categories: ExportedCategories;
  readonly restricted: ExportedRestricted;
  /**
   * `errorMessage` and `errorStack` when the work read data of someone else too, so the text is
   * sealed under them as well and may quote it.
   */
  readonly withheld: readonly ExportedWithheld[];
}

/**
 * A dispatch remembered under an idempotency key whose answer names the person, sealed under
 * their keys: what it answered, opened. It is remembered until `expiresAt`.
 */
export interface ExportedAnswer {
  /**
   * `null` when it is withheld.
   */
  readonly idempotencyKey: string | null;
  readonly expiresAt: string;
  /**
   * `null` when it is withheld.
   */
  readonly outcome: DispatchOutcome | null;
  /**
   * `["outcome"]` while any restriction of the person holds: the answer may quote any of their
   * data; and as `ExportedRestricted` says with `includeWithheld`.
   */
  readonly restricted: ExportedRestricted;
  /**
   * `idempotencyKey` and `outcome` when the answer is sealed under someone else too, a rejection
   * decided on a state that held their data or a command that touches them, which it may quote.
   */
  readonly withheld: readonly ExportedWithheld[];
}

/**
 * The last failure of a subscriber on an event that names the person, or whose delivery read their
 * data, whose error text is sealed under their keys: opened, `null` once anyone it is sealed under
 * is forgotten, or when it is withheld.
 */
export interface ExportedSubscriberFailure {
  readonly subscriber: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly errorMessage: string | null;
  readonly errorStack?: string | null;
  readonly restricted: ExportedRestricted;
  /**
   * `errorMessage` and `errorStack` when the delivery read data of someone else too, as
   * `ExportedDeadLetter` holds them back.
   */
  readonly withheld: readonly ExportedWithheld[];
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
 * The version of the format a person's export is written in, as its `version` says.
 */
export const PERSONAL_DATA_EXPORT_VERSION: 1 = 1;

/**
 * What `exportPersonalData` answers: every record the runtime holds that names the person, with
 * the fields marked `personal` of theirs opened, and the rows of every read model with a field
 * marked `.person()` that name them. Fields left unmarked are not personal data to Bounda and stay
 * out, as do the rows of read models without such a field and whatever left the store.
 */
export interface PersonalDataExport {
  /**
   * The version of the format the export is written in, which a reader checks before it reads
   * anything else: one that changes what a section holds, or adds one, is a new one. An export
   * without it was written before Bounda numbered the format.
   */
  readonly version: typeof PERSONAL_DATA_EXPORT_VERSION;
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
   * The recipients of their data, or the categories of recipients, as article 15(1)(c) asks: each
   * port's recipient that was disclosed data of theirs, may hold it, or may receive it, with the
   * categories concerned and their basis, its country and the safeguard of a transfer out of the
   * European Economic Area. Each event of `bounda:<personId>` names in `recipients` whom it told.
   */
  readonly recipients: readonly PersonRecipient[];
  /**
   * The stores the app keeps under another legal regime than `storage`'s, with the safeguard that
   * allows it, as article 15(2) asks; none when every store is kept under `storage`'s.
   */
  readonly transfers: readonly ExportedTransfer[];
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
    | "version"
    | "personId"
    | "exportedAt"
    | "position"
    | "categories"
    | "rights"
    | "automatedDecisions"
    | "restrictions"
    | "recipients"
    | "transfers"
  > {
  readonly readModels: readonly string[];
}

/**
 * One piece of a streamed export: the header first, then each record, in the order and the
 * sections of `PersonalDataExport`: redactions, events, scheduled commands, dead letters,
 * subscriber failures, answers, and the rows of each read model, the header's `readModels` in turn.
 */
export type PersonalDataExportPart =
  | { readonly kind: "header"; readonly header: PersonalDataExportHeader }
  | { readonly kind: "redaction"; readonly redaction: ExportedRedaction }
  | { readonly kind: "event"; readonly event: ExportedEvent }
  | { readonly kind: "scheduledCommand"; readonly scheduledCommand: ExportedScheduledCommand }
  | { readonly kind: "deadLetter"; readonly deadLetter: ExportedDeadLetter }
  | { readonly kind: "subscriberFailure"; readonly subscriberFailure: ExportedSubscriberFailure }
  | { readonly kind: "answer"; readonly answer: ExportedAnswer }
  | { readonly kind: "row"; readonly readModel: string; readonly row: ExportedRow };

export type PersonalDataExportRecord = Exclude<PersonalDataExportPart, { readonly kind: "header" }>;

/**
 * How many records of each kind an export handed out.
 */
export type ExportedCounts = Omit<ExportAccess["detail"], "exportId" | "includeWithheld">;

export interface CountPartFunction {
  (counts: ExportedCounts, part: PersonalDataExportPart): ExportedCounts;
}

export const NO_EXPORTED_RECORDS: ExportedCounts = {
  redactions: 0,
  events: 0,
  scheduledCommands: 0,
  deadLetters: 0,
  subscriberFailures: 0,
  answers: 0,
  readModelRows: 0,
  recipients: 0,
  withheld: 0,
};

// A record that held a value back under article 15(4) counts in `withheld` too.
const withheld = (counts: ExportedCounts, held: readonly unknown[]): number =>
  counts.withheld + (held.length > 0 ? 1 : 0);

export const countPart: CountPartFunction = (counts, part) => {
  switch (part.kind) {
    case "header":
      return { ...counts, recipients: part.header.recipients.length };
    case "redaction":
      return { ...counts, redactions: counts.redactions + 1 };
    case "event":
      return { ...counts, events: counts.events + 1 };
    case "scheduledCommand":
      return { ...counts, scheduledCommands: counts.scheduledCommands + 1 };
    case "deadLetter":
      return {
        ...counts,
        deadLetters: counts.deadLetters + 1,
        withheld: withheld(counts, part.deadLetter.withheld),
      };
    case "subscriberFailure":
      return {
        ...counts,
        subscriberFailures: counts.subscriberFailures + 1,
        withheld: withheld(counts, part.subscriberFailure.withheld),
      };
    case "answer":
      return {
        ...counts,
        answers: counts.answers + 1,
        withheld: withheld(counts, part.answer.withheld),
      };
    case "row":
      return { ...counts, readModelRows: counts.readModelRows + 1 };
  }
};

export interface CollectPersonalDataExportFunction {
  (parts: AsyncIterable<PersonalDataExportPart>): Promise<PersonalDataExport>;
}

export const collectPersonalDataExport: CollectPersonalDataExportFunction = async (parts) => {
  let header: PersonalDataExportHeader | undefined;
  const redactions: ExportedRedaction[] = [];
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
      case "redaction":
        redactions.push(part.redaction);
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
    redactions,
    events,
    scheduledCommands,
    deadLetters,
    subscriberFailures,
    answers,
    readModels: Object.fromEntries(rows),
  };
};
