import type { Logger } from "../contracts/logger.ts";
import type { AppEnv } from "../register/index.ts";
import type { RestrictionBasis } from "./personal-data.ts";

/**
 * The most persons one access record names; `personCount` says how many there were in all.
 */
export const MAX_ACCESS_PERSONS = 100;

interface AccessRecord {
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
  /**
   * `ok` when the operation handed its result out; `failed` when it rejected after reading, with
   * an error that may quote what it read.
   */
  readonly outcome: AccessOutcome;
  /**
   * The restricted data the operation opened on a basis named explicitly, `null` when it named
   * none: a query, a dead letter or a subscriber failure read with `includeRestricted`, a command
   * dispatched with `processRestricted`, a policy or process that declares `restricted`.
   */
  readonly restricted: RestrictedAccess | null;
}

/**
 * How an operation that read personal data ended.
 */
export type AccessOutcome = "ok" | "failed";

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
 * `exportPersonalData`, with how many records of each kind it handed out; `detail` is `null` when
 * it failed, having handed nothing out.
 */
export interface ExportAccess extends AccessRecord {
  readonly operation: "exportPersonalData";
  readonly detail: {
    readonly events: number;
    readonly scheduledCommands: number;
    readonly deadLetters: number;
    readonly subscriberFailures: number;
    readonly readModelRows: number;
  } | null;
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

export type PersonalDataAccess =
  | QueryAccess
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
 * read and before it settles, whether it hands its result out or rejects, never sampled; the
 * operation waits for it and rejects with what it throws, handing nothing out, since data handed
 * out unrecorded defeats the log. Without `app/audit.ts`, each record goes to the app's logger at
 * `info`.
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
