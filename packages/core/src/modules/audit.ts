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
   * The class of what a call recorded `failed` or `refused` rejected with, or `typeof` what was
   * thrown when it is no error, as a log line names it; `null` for every other outcome. Never its
   * message, which may quote what the call read.
   */
  readonly errorName: string | null;
  /**
   * The `code` of that error when it is one of Bounda's, `null` otherwise.
   */
  readonly errorCode: string | null;
  /**
   * The restricted data the operation opened on a basis named explicitly, `null` when it named
   * none: a query, a dead letter or a subscriber failure read with `includeRestricted`, a command
   * dispatched with `processRestricted`, a policy or process that declares `restricted`.
   */
  readonly restricted: RestrictedAccess | null;
}

/**
 * How an operation that read personal data ended: `ok` when it handed its result out; `failed`
 * when it rejected once it read, with an error that may quote what it read.
 */
export type AccessOutcome = "ok" | "failed";

/**
 * How a call that reads personal data ended: as `AccessOutcome` says, or `refused` when it
 * rejected before it opened anything, so its error quotes nothing it read: an argument that does
 * not validate, a read model whose database is not served, a dead letter already settled, a read
 * of stored letters or failures, still sealed, that failed.
 */
export type ReadOutcome = AccessOutcome | "refused";

/**
 * Where an export stands: `started` before it hands anything out, so one its reader leaves unread,
 * or whose process dies, is recorded all the same; then how it ended, in a second record with the
 * same `exportId`: `ok`, `failed`, or `cancelled` when its reader stopped before the end. A
 * `started` with no end may have handed out anything up to the whole export. An export refused
 * before it read anything has one record, `refused`.
 */
export type ExportOutcome = "started" | ReadOutcome | "cancelled";

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
export interface QueryAccess extends AccessRecord<ReadOutcome> {
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
 * `exportTenant`, recorded as it starts and as it ends, as `ExportAccess` is, with how many parts
 * of each kind it handed out by then. It hands out the data of every person of the tenant: `persons`
 * are the first of them, in the order the export hands them out, and `personCount` all of them so
 * far, none at its start.
 */
export interface TenantExportAccess extends AccessRecord<ExportOutcome> {
  readonly operation: "exportTenant";
  readonly detail: {
    /**
     * The export's own id, the same in every record of it and in the export's header.
     */
    readonly exportId: string;
    readonly persons: number;
    readonly recipients: number;
    readonly events: number;
    readonly scheduledCommands: number;
    readonly deadLetters: number;
    readonly subscriberFailures: number;
    readonly answers: number;
    readonly readModelRows: number;
    readonly forgetLedgerEntries: number;
  };
}

/**
 * `deadLetters.list`, with how many letters it read. `persons` are those the letters name, under
 * whose key their error text or payload is sealed.
 */
export interface DeadLettersListAccess extends AccessRecord<ReadOutcome> {
  readonly operation: "deadLetters.list";
  readonly detail: {
    readonly letters: number;
  };
}

/**
 * `deadLetters.get`, `retry` or `discard` of one letter.
 */
export interface DeadLetterAccess extends AccessRecord<ReadOutcome> {
  readonly operation: "deadLetters.get" | "deadLetters.retry" | "deadLetters.discard";
  readonly detail: {
    readonly letter: string;
  };
}

/**
 * `subscriberFailures.list`, with how many failures it read. `persons` are those the failures'
 * events name, under whose key their error text is sealed.
 */
export interface SubscriberFailuresListAccess extends AccessRecord<ReadOutcome> {
  readonly operation: "subscriberFailures.list";
  readonly detail: {
    readonly failures: number;
  };
}

/**
 * `subscriberFailures.get` of one subscriber's last failure.
 */
export interface SubscriberFailureAccess extends AccessRecord<ReadOutcome> {
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
export interface RecipientsOfAccess extends AccessRecord<ReadOutcome> {
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
  | TenantExportAccess
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
  readonly tenant: string;
  readonly logger: Logger;
}

/**
 * Where the access log goes, exported from `app/audit.ts`: a log pipeline, a SIEM, a table of
 * another database. Called once per call of an operation that reads personal data in the clear,
 * however it ends: after it read and before it settles, whether it hands its result out or
 * rejects, or as it is refused before it reads; for an export also before it hands anything out.
 * Never sampled. The operation waits for it and rejects with what
 * it throws, handing nothing out, since data handed out unrecorded defeats the log. Without
 * `app/audit.ts`, each record goes to the app's logger at `info`.
 */
export interface OnPersonalDataAccess {
  (args: OnPersonalDataAccessArgs): void | Promise<void>;
}

/**
 * Why a host refused a request before the app served it, or the app refused it for its tenant:
 *
 * - `no-route`: the path names no route the host serves.
 * - `method-not-allowed`: the route takes another method.
 * - `payload-too-large`: the body is larger than the host takes.
 * - `invalid-json`: the body is not JSON.
 * - `tenant-unresolved`: the host's tenant function threw, or named no store.
 * - `actor-unresolved`: the host's actor function threw, as one does that refuses a request
 *   without a session or redirects it to sign in.
 * - `actor-invalid`: `as` refused what the actor function named.
 * - `unknown-command`, `unknown-query`: no command or query of that name.
 * - `tenant-forgotten`: the tenant was forgotten.
 * - `tenant-frozen`: the tenant is frozen, and the call writes.
 */
export type HostRejectionReason =
  | "no-route"
  | "method-not-allowed"
  | "payload-too-large"
  | "invalid-json"
  | "tenant-unresolved"
  | "actor-unresolved"
  | "actor-invalid"
  | "unknown-command"
  | "unknown-query"
  | "tenant-forgotten"
  | "tenant-frozen";

/**
 * One record of the host log: a request refused before the app served it. Ids and names alone,
 * never the request's path, body or headers, nor the error's message.
 */
export interface HostRejection {
  /**
   * When, on the clock of whoever refused it.
   */
  readonly at: string;
  /**
   * The store the request was for, `null` when it was refused before its tenant was known.
   */
  readonly tenant: string | null;
  readonly reason: HostRejectionReason;
  /**
   * What the request asked for: the route's pattern in React Router, `commands/<name>` or
   * `queries/<name>` for the Worker, `commands.<name>` or `queries.<name>` for a command or query,
   * or the client's operation, such as `exportPersonalData`; `null` for a path that names no route.
   */
  readonly target: string | null;
  /**
   * Who made it, as the access log names them: the actor `as` acts as, `null` for nobody, and for
   * a request refused before its actor was known or whose actor was refused.
   */
  readonly actor: string | null;
}

/**
 * What `onHostRejection` receives: the record, and the host's environment and logger.
 */
export interface OnHostRejectionArgs {
  readonly rejection: HostRejection;
  readonly env: AppEnv;
  readonly logger: Logger;
}

/**
 * Where the host log goes, exported from `app/audit.ts` beside `onPersonalDataAccess`. Called once
 * per request refused before the app served it, and the refusal waits for it: when it throws, the
 * request fails with that error instead. Never sampled. Without `app/audit.ts`, each record goes
 * to the host's logger at `info`.
 */
export interface OnHostRejection {
  (args: OnHostRejectionArgs): void | Promise<void>;
}

/**
 * The shape of `app/audit.ts`, which the generated registry checks it against.
 */
export interface AuditModule {
  readonly onPersonalDataAccess: OnPersonalDataAccess;
  readonly onHostRejection: OnHostRejection;
}
