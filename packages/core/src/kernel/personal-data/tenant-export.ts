import type {
  DeadLetterErrorType,
  DeadLetterKind,
  DeadLetterStatus,
} from "../../adapter/storage/dead-letter-store.ts";
import type { ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { DispatchOutcome } from "../../adapter/storage/idempotency-store.ts";
import type { CausationContext, EventMetadata } from "../../contracts/metadata.ts";
import type { TenantExportAccess } from "../../modules/audit.ts";
import type { ProcessingRestriction } from "../../modules/personal-data.ts";
import type { PersonRecipient } from "../../modules/recipient.ts";
import type {
  ExportedCategories,
  ExportedCategory,
  ExportedRestricted,
  ExportedTransfer,
} from "./export.ts";

/**
 * What the first line of a tenant export names its format: a reader checks it, and `version`,
 * before it reads anything else.
 */
export const TENANT_EXPORT_FORMAT: "bounda.tenant-export" = "bounda.tenant-export";

/**
 * The version of the format a tenant export is written in. A version that changes what a part
 * holds, or adds a kind of part, is a new one.
 */
export const TENANT_EXPORT_VERSION: 4 = 4;

/**
 * A category of the app as `app/personal-data.ts` declares it, as `ExportedCategory` tells a
 * person of it, without what only holds for one person, and with the ports that bring its data in.
 */
export interface TenantExportCategory
  extends Omit<ExportedCategory, "held" | "keptUntil" | "restrictedUntil"> {
  /**
   * The ports whose calls return data of it, `<aggregate or read model>.<port>`, as their
   * `returnsPersonalData` says: where it comes from besides what the app is given.
   */
  readonly ports: readonly string[];
}

/**
 * Up to where in the stream what a tenant export's header says is derived from it reached.
 */
export interface TenantExportReached {
  readonly readModels: Readonly<Record<string, number>>;
  readonly forgetLedger: number | null;
}

/**
 * What a tenant export hands out before any record: its format, the tenant, when it was taken, the
 * head of the stream its events reach, every category of the app, the stores kept in another
 * jurisdiction, and every read model, in the order their rows come.
 */
export interface TenantExportHeader {
  readonly format: typeof TENANT_EXPORT_FORMAT;
  readonly version: typeof TENANT_EXPORT_VERSION;
  readonly tenant: string;
  /**
   * The export's own id, which every record of it in the access log carries.
   */
  readonly exportId: string;
  /**
   * When the export was taken, on the app's clock.
   */
  readonly exportedAt: string;
  /**
   * The head of the stream when the export began: `event` parts hold every event up to it, and the
   * export fails if the stream moved past it before it ended.
   */
  readonly position: number;
  /**
   * Since when the tenant is frozen: the export is one cut of every store, which no write changed
   * while it was read.
   */
  readonly frozenAt: string;
  /**
   * Up to where in the stream what is derived from it reached at the cut: the rows of each read
   * model, by name, and the entries the forget ledger copied from the stream, `null` without one.
   * A position short of `position` had not caught up when the tenant was frozen.
   */
  readonly reached: TenantExportReached;
  readonly categories: Readonly<Record<string, TenantExportCategory>>;
  /**
   * The stores the app keeps out of the jurisdiction `storage` declares, with the safeguard that
   * allows it, as a person's export lists them; none when every store is kept where `storage` is.
   * Where each recipient is, and the safeguard of a transfer to it, `recipient` parts say.
   */
  readonly transfers: readonly ExportedTransfer[];
  readonly readModels: readonly string[];
}

/**
 * What the runtime holds of one person of the tenant besides their records: since when it last saw
 * them, whether a forgetting came after, the categories of theirs it keeps a key of, their
 * restrictions, and the recipients of their data (article 19). Never a key.
 */
export interface TenantExportedPerson {
  readonly personId: string;
  /**
   * The timestamp of the last event of the app's aggregates that named them, `null` when none has.
   */
  readonly lastActiveAt: string | null;
  /**
   * The timestamp of the `PersonalDataForgotten` recorded after their last activity, `null` when
   * none is.
   */
  readonly forgottenAt: string | null;
  /**
   * Each category they hold data of, as `ExportedCategory` says it for them: when the retention
   * forgets it, and until when a forgetting keeps what an erasure exemption held back.
   */
  readonly categories: Readonly<
    Record<string, Pick<ExportedCategory, "keptUntil" | "restrictedUntil">>
  >;
  readonly restrictions: readonly ProcessingRestriction[];
  readonly recipients: readonly PersonRecipient[];
}

/**
 * A recipient of the tenant's data, as the `person` parts list it, summed over every person: one
 * per port, identity it had then (its name, kind, country and the safeguard of a transfer) and
 * status, with every category concerned, the earliest and the latest disclosure, and how many
 * persons it is listed so for. A recipient the app declares that no person is listed for, under
 * its identity now, comes as `declared`, with every category its declaration names, for none.
 */
export interface TenantExportRecipient extends PersonRecipient {
  /**
   * How many of the tenant's persons list it so.
   */
  readonly persons: number;
}

/**
 * An event of the stream, as the app's handlers read it today: upcast to its current schema, every
 * field of its payload opened, a field forgotten or redacted `null`.
 */
export interface TenantExportedEvent {
  readonly id: string;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly position: number;
  readonly timestamp: string;
  readonly metadata: EventMetadata;
  readonly person: string | null;
  readonly payload: unknown;
  /**
   * The category of each field of the payload marked `personal`, by field.
   */
  readonly categories: ExportedCategories;
  /**
   * The fields of a category restricted for the person, or kept past a forgetting under an
   * erasure exemption, which the controller only keeps.
   */
  readonly restricted: ExportedRestricted;
  /**
   * The fields a redaction sealed for good (article 16): they read `null`.
   */
  readonly redacted: readonly string[];
}

/**
 * A command waiting to run, its payload opened.
 */
export interface TenantExportedScheduledCommand {
  readonly dedupeKey: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly executeAt: string;
  /**
   * Absent for one stored before Bounda recorded it.
   */
  readonly scheduledAt?: string;
  readonly context: CausationContext;
  readonly attempts: number;
  /**
   * Whom the personal fields of the payload name.
   */
  readonly persons: readonly string[];
  readonly categories: ExportedCategories;
  /**
   * The fields of a category restricted for a person it names, or kept past their forgetting.
   */
  readonly restricted: ExportedRestricted;
}

/**
 * A handler run that gave up, with its error's text and its payload opened: the text `null` once
 * anyone it is sealed under is forgotten.
 */
export interface TenantExportedDeadLetter {
  readonly id: string;
  readonly kind: DeadLetterKind;
  readonly handler: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly person: string | null;
  readonly statePerson?: string;
  readonly readPersons?: readonly string[];
  readonly errorType: DeadLetterErrorType;
  readonly errorName: string;
  readonly errorCode?: string;
  readonly errorMessage: string | null;
  readonly errorStack?: string | null;
  readonly attempts: number;
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
  readonly status: DeadLetterStatus;
  readonly resolvedAt?: string;
  /**
   * The payload of a scheduled command, absent for a policy or process letter.
   */
  readonly payload?: unknown;
  /**
   * Whom the personal fields of the payload name.
   */
  readonly persons: readonly string[];
  readonly categories: ExportedCategories;
  /**
   * As a scheduled command's, and `errorMessage` and `errorStack` while a person their text is
   * sealed under has a restriction.
   */
  readonly restricted: ExportedRestricted;
}

/**
 * The last failure of a subscriber, its error's text opened, `null` once anyone it is sealed under
 * is forgotten.
 */
export interface TenantExportedSubscriberFailure {
  readonly subscriber: string;
  readonly position: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly person: string | null;
  readonly readPersons?: readonly string[];
  readonly errorName: string;
  readonly errorCode?: string;
  readonly errorMessage: string | null;
  readonly errorStack?: string | null;
  readonly attempts: number;
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
  readonly resolvedAt: string | null;
  /**
   * `errorMessage` and `errorStack` while a person their text is sealed under has a restriction.
   */
  readonly restricted: ExportedRestricted;
}

/**
 * What a dispatch under an idempotency key answered, remembered until `expiresAt`, opened; one no
 * key opens any more is left out, as it holds nothing.
 */
export interface TenantExportedAnswer {
  readonly idempotencyKey: string;
  readonly expiresAt: string;
  readonly outcome: DispatchOutcome;
  /**
   * Whom the answer is sealed under.
   */
  readonly persons: readonly string[];
  /**
   * `["outcome"]` while one of them has a restriction.
   */
  readonly restricted: ExportedRestricted;
}

/**
 * A row of a read model, every field of its view opened, one forgotten or that the row lacks
 * `null`.
 */
export interface TenantExportedRow {
  readonly key: unknown;
  readonly data: Readonly<Record<string, unknown>>;
  /**
   * The person the field marked `.person()` names, `null` in a read model without one.
   */
  readonly person: string | null;
  readonly categories: ExportedCategories;
  /**
   * The fields of a category restricted for the person, or kept past a forgetting.
   */
  readonly restricted: ExportedRestricted;
}

/**
 * How many parts of each kind a tenant export handed out.
 */
export type TenantExportCounts = Omit<TenantExportAccess["detail"], "exportId">;

/**
 * One piece of a tenant export, in this order: the header, every person, every recipient of their
 * data, every event up to the header's `position`, every scheduled command, dead letter, subscriber
 * failure and remembered answer, the rows of each read model, the header's `readModels` in turn,
 * every entry of `runtime.personalData.forgetLedger`, and last `end`, with how many parts of each
 * kind came: an export without its `end` is not whole.
 */
export type TenantExportPart =
  | { readonly kind: "header"; readonly header: TenantExportHeader }
  | { readonly kind: "person"; readonly person: TenantExportedPerson }
  | { readonly kind: "recipient"; readonly recipient: TenantExportRecipient }
  | { readonly kind: "event"; readonly event: TenantExportedEvent }
  | { readonly kind: "scheduledCommand"; readonly scheduledCommand: TenantExportedScheduledCommand }
  | { readonly kind: "deadLetter"; readonly deadLetter: TenantExportedDeadLetter }
  | {
      readonly kind: "subscriberFailure";
      readonly subscriberFailure: TenantExportedSubscriberFailure;
    }
  | { readonly kind: "answer"; readonly answer: TenantExportedAnswer }
  | { readonly kind: "row"; readonly readModel: string; readonly row: TenantExportedRow }
  | { readonly kind: "forgetLedgerEntry"; readonly entry: ForgetLedgerEntry }
  | { readonly kind: "end"; readonly counts: TenantExportCounts };

export type TenantExportRecord = Exclude<
  TenantExportPart,
  { readonly kind: "header" } | { readonly kind: "end" }
>;

export const NO_TENANT_EXPORT_RECORDS: TenantExportCounts = {
  persons: 0,
  recipients: 0,
  events: 0,
  scheduledCommands: 0,
  deadLetters: 0,
  subscriberFailures: 0,
  answers: 0,
  readModelRows: 0,
  forgetLedgerEntries: 0,
};

const COUNTED: Readonly<Record<TenantExportRecord["kind"], keyof TenantExportCounts>> = {
  person: "persons",
  recipient: "recipients",
  event: "events",
  scheduledCommand: "scheduledCommands",
  deadLetter: "deadLetters",
  subscriberFailure: "subscriberFailures",
  answer: "answers",
  row: "readModelRows",
  forgetLedgerEntry: "forgetLedgerEntries",
};

export interface CountTenantRecordFunction {
  (counts: TenantExportCounts, record: TenantExportRecord): TenantExportCounts;
}

export const countTenantRecord: CountTenantRecordFunction = (counts, { kind }) => {
  const counted = COUNTED[kind];
  return { ...counts, [counted]: counts[counted] + 1 };
};
