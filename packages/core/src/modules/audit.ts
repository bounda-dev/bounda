import type { Logger } from "../contracts/logger.ts";
import type { AppEnv } from "../register/index.ts";
import type { RestrictionBasis } from "./personal-data.ts";

/**
 * The most persons one access record names; `personCount` says how many there were in all.
 */
export const MAX_ACCESS_PERSONS = 100;

interface AccessRecord<Outcome extends string = AccessOutcome> {
  /**
   * Who opened the data: the actor of the client (`as`), `null` for a client that names nobody.
   */
  readonly actor: string | null;
  /**
   * Whose personal data was opened, each once, in the order it was read, at most
   * `MAX_ACCESS_PERSONS` of them.
   */
  readonly persons: readonly string[];
  /**
   * How many persons in all, more than `persons` holds when it was cut short.
   */
  readonly personCount: number;
  /**
   * When, on the app's clock.
   */
  readonly at: string;
  readonly outcome: Outcome;
  /**
   * The restricted data the operation opened on a basis named explicitly, `null` when it named
   * none: a query, a dead letter or a subscriber failure read with `includeRestricted`, a command
   * dispatched with `processRestricted`, a policy or process that declares `restricted`.
   */
  readonly restricted: RestrictedAccess | null;
}

/**
 * How an operation that read personal data ended: `ok` when it handed its result out; `failed`
 * when it rejected after reading, with an error that may quote what it read.
 */
export type AccessOutcome = "ok" | "failed";

/**
 * Where an export stands: `started` before it hands anything out, so one its reader leaves unread,
 * or whose process dies, is recorded all the same; then how it ended, in a second record with the
 * same `exportId`: `ok`, `failed`, or `cancelled` when its reader stopped before the end. A
 * `started` with no end may have handed out anything up to the whole export.
 */
export type ExportOutcome = "started" | AccessOutcome | "cancelled";

/**
 * The persons whose restricted data an operation opened, and the basis it named, as article 18(2)
 * asks it be accountable for: each once, at most `MAX_ACCESS_PERSONS` of them, and how many in all.
 */
export interface RestrictedAccess {
  readonly basis: RestrictionBasis;
  readonly persons: readonly string[];
  readonly personCount: number;
}

/**
 * A query of a read model with fields marked `.personal()`. `persons` are those the `person`
 * field names in the rows the query read through its `table` or `client`.
 */
export interface QueryAccess extends AccessRecord {
  readonly operation: "query";
  /**
   * `true` when the query took `client.raw`, the driver itself: whose rows it read there is
   * unknown, so `persons` names only those of the rows read through `table` and `client`.
   */
  readonly unattributed: boolean;
  readonly detail: {
    readonly query: string;
    readonly readModel: string;
  };
}

/**
 * `exportPersonalData` or `streamPersonalData`, recorded as it starts and as it ends, with how many
 * records of each kind it handed out by then: at its start, the recipients of its header. `persons`
 * is the person exported, and, with `includeWithheld`, after them everyone else whose data the
 * values it opened in spite of article 15(4) may quote.
 */
export interface ExportAccess extends AccessRecord<ExportOutcome> {
  readonly operation: "exportPersonalData";
  readonly detail: {
    /**
     * The export's own id, the same in every record of it.
     */
    readonly exportId: string;
    readonly redactions: number;
    readonly events: number;
    readonly scheduledCommands: number;
    readonly deadLetters: number;
    readonly subscriberFailures: number;
    readonly answers: number;
    readonly readModelRows: number;
    readonly recipients: number;
    /**
     * The records with a value held back under article 15(4), or opened in spite of it with
     * `includeWithheld`.
     */
    readonly withheld: number;
    readonly includeWithheld: boolean;
  };
}

/**
 * `deadLetters.list`, with how many letters it read. `persons` are those the letters name, under
 * whose key their error text or payload is sealed.
 */
export interface DeadLettersListAccess extends AccessRecord {
  readonly operation: "deadLetters.list";
  readonly detail: {
    readonly letters: number;
  };
}

/**
 * `deadLetters.get`, `retry` or `discard` of one letter.
 */
export interface DeadLetterAccess extends AccessRecord {
  readonly operation: "deadLetters.get" | "deadLetters.retry" | "deadLetters.discard";
  readonly detail: {
    readonly letter: string;
  };
}

/**
 * `subscriberFailures.list`, with how many failures it read. `persons` are those the failures'
 * events name, under whose key their error text is sealed.
 */
export interface SubscriberFailuresListAccess extends AccessRecord {
  readonly operation: "subscriberFailures.list";
  readonly detail: {
    readonly failures: number;
  };
}

/**
 * `subscriberFailures.get` of one subscriber's last failure.
 */
export interface SubscriberFailureAccess extends AccessRecord {
  readonly operation: "subscriberFailures.get";
  readonly detail: {
    readonly subscriber: string;
  };
}

/**
 * One record of the access log: an operation that handed out personal data in the clear, who
 * called it and whose data it was.
 */
/**
 * Work that processed restricted data on a basis named explicitly: a command dispatched with
 * `processRestricted`, or a run of a policy, a process step or a scheduled command whose module
 * declares `restricted`. `persons` names those whose restricted data it opened.
 */
export interface RestrictedProcessingAccess extends AccessRecord {
  readonly operation: "command" | "policy" | "process" | "scheduledCommand";
  readonly restricted: RestrictedAccess;
  readonly detail: {
    /**
     * The command's type, or the policy's or process's key.
     */
    readonly handler: string;
  };
}

/**
 * Work that called a port whose recipient receives personal data: `persons` are those whose data
 * of the recipient's categories the work had read, recorded as disclosed to it.
 */
export interface DisclosureAccess extends AccessRecord {
  readonly operation: "disclosure";
  readonly detail: {
    /**
     * The port, `"<aggregate or read model>.<port>"`.
     */
    readonly recipient: string;
    /**
     * The command's type, the policy's or process's key, or the query's name.
     */
    readonly handler: string;
    readonly categories: readonly string[];
  };
}

/**
 * A recipient told of a forgetting, a restriction, a lift or a redaction (article 19), by its
 * handler. `superseded` is `true` when the handler did not run because a later forgetting of the
 * person as a whole was told to the recipient already.
 */
export interface RecipientNoticeAccess extends AccessRecord {
  readonly operation: "recipientNotice";
  readonly detail: {
    readonly recipient: string;
    readonly event: string;
    readonly eventId: string;
    readonly categories: readonly string[];
    readonly superseded: boolean;
  };
}

/**
 * `recipientsOf`, with how many recipients it listed; `null` when it failed.
 */
export interface RecipientsOfAccess extends AccessRecord {
  readonly operation: "recipientsOf";
  readonly detail: { readonly recipients: number } | null;
}

export type PersonalDataAccess =
  | QueryAccess
  | DisclosureAccess
  | RecipientNoticeAccess
  | RecipientsOfAccess
  | RestrictedProcessingAccess
  | ExportAccess
  | DeadLettersListAccess
  | DeadLetterAccess
  | SubscriberFailuresListAccess
  | SubscriberFailureAccess;

/**
 * What `onPersonalDataAccess` receives: the record, and the host's environment and store name as a
 * port implementation's `create` receives them.
 */
export interface OnPersonalDataAccessArgs {
  readonly access: PersonalDataAccess;
  readonly env: AppEnv;
  readonly tenant?: string;
  readonly logger: Logger;
}

/**
 * Where the access log goes, exported from `app/audit.ts`: a log pipeline, a SIEM, a table of
 * another database. Called once per operation that reads personal data in the clear, after it
 * read and before it settles, whether it hands its result out or rejects, and for an export also
 * before it hands anything out; never sampled. The operation waits for it and rejects with what
 * it throws, handing nothing out, since data handed out unrecorded defeats the log. Without
 * `app/audit.ts`, each record goes to the app's logger at `info`.
 */
export interface OnPersonalDataAccess {
  (args: OnPersonalDataAccessArgs): void | Promise<void>;
}

/**
 * The shape of `app/audit.ts`, which the generated registry checks it against.
 */
export interface AuditModule {
  readonly onPersonalDataAccess: OnPersonalDataAccess;
}
