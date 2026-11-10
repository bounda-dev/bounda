import type { StoredEvent } from "../contracts/event.ts";
import type { PersonalCategoryName } from "./personal-data.ts";

/**
 * The aggregate the runtime's own events belong to, one stream per subject: a read model
 * projects them from `projections/bounda/<event>.ts`, and a policy reacts to them from
 * `policies/bounda/<action>-on-<event>.ts`. No aggregate of the app can take the name.
 */
export const BOUNDA_AGGREGATE: "bounda" = "bounda";

/**
 * Appended to the stream `bounda:<personId>` once the person's key is gone, by `forget(personId)`,
 * a policy or process that forgets them, or the retention: every event's personal field of theirs
 * reads as `null` from then on, and every read model that projects such fields handles it. It
 * names the stored commands that held the person's data and went with the key, since no other
 * event records them. With a forget ledger, the reconciliation may append it again, with the same
 * id, time and reason, to a store that lost it.
 */
export const PERSONAL_DATA_FORGOTTEN_EVENT: "PersonalDataForgotten" = "PersonalDataForgotten";

/**
 * A command scheduled with `delay` that `forget` cancelled before it ran.
 */
export interface CancelledCommand {
  readonly commandId: string;
  readonly type: string;
}

/**
 * The dead letter of a scheduled command that `forget` removed, whatever its status.
 */
export interface RemovedDeadLetter {
  readonly id: string;
  readonly commandType: string;
}

/**
 * Why a person was forgotten: `requested` by `forget`, from a client or a policy or process, or
 * by `bounda forget --from` for a bare id, or `retention`, past `runtime.personalData.retention`,
 * or a category's own, without activity. A forgetting committed again from `runtime.personalData.forgetLedger`, after
 * a restore or a commit that never happened, keeps the reason it was asked with.
 */
export type PersonalDataForgottenReason = "requested" | "retention";

export interface PersonalDataForgottenPayload {
  readonly personId: string;
  readonly reason: PersonalDataForgottenReason;
  /**
   * Whether the person was forgotten as a whole, by `forget(person)`, the app's retention or a
   * restore of either, with no key left in force; `false` when only some categories were, by
   * `forget(person, { categories })` or a category's retention, or when a forgetting committed
   * again kept a key given to the person after it.
   */
  readonly whole: boolean;
  /**
   * The categories forgotten: their fields read as `null` from then on. As a whole, every
   * category but those `retained`.
   */
  readonly categories: readonly PersonalCategoryName[];
  /**
   * The categories kept under a legal obligation instead, restricted until their retention ends,
   * when another `PersonalDataForgotten` names them in `expired`.
   */
  readonly retained: readonly PersonalCategoryName[];
  /**
   * The categories kept at an earlier forgetting whose retention ended: what was kept of them is
   * forgotten now.
   */
  readonly expired: readonly PersonalCategoryName[];
  /**
   * The fingerprints of the keys the forgetting covered, destroyed or retained, none when it
   * covered none: a key in force the person holds whose fingerprint is not here was given to them
   * after. Absent from a forgetting recorded before Bounda 0.4.0.
   */
  readonly fingerprints?: readonly string[];
  readonly cancelledCommands: readonly CancelledCommand[];
  readonly removedDeadLetters: readonly RemovedDeadLetter[];
}

export type PersonalDataForgottenEvent = StoredEvent<
  typeof PERSONAL_DATA_FORGOTTEN_EVENT,
  PersonalDataForgottenPayload
>;

/**
 * Appended by `restrict(personId)` to the stream `bounda:<personId>`, once their row says so:
 * every command that touches the person is refused with `ProcessingRestrictedError` from then on,
 * and the reactions it refuses wait as dead letters. Handling it is optional: a read model may
 * show the person as restricted, a policy may tell the outside world.
 */
export const PROCESSING_RESTRICTED_EVENT: "ProcessingRestricted" = "ProcessingRestricted";

/**
 * Appended by `unrestrict(personId)` to the stream `bounda:<personId>`, once the restriction is
 * lifted: the dead letters it caused are retried by the runtime, in the background.
 */
export const PROCESSING_RESTRICTION_LIFTED_EVENT: "ProcessingRestrictionLifted" =
  "ProcessingRestrictionLifted";

export interface ProcessingRestrictedPayload {
  readonly personId: string;
}

export type ProcessingRestrictedEvent = StoredEvent<
  typeof PROCESSING_RESTRICTED_EVENT,
  ProcessingRestrictedPayload
>;

export interface ProcessingRestrictionLiftedPayload {
  readonly personId: string;
}

export type ProcessingRestrictionLiftedEvent = StoredEvent<
  typeof PROCESSING_RESTRICTION_LIFTED_EVENT,
  ProcessingRestrictionLiftedPayload
>;

/**
 * The runtime's events, by the key a module's file name gives them.
 */
export const BOUNDA_EVENTS: Readonly<Record<string, string>> = {
  personalDataForgotten: PERSONAL_DATA_FORGOTTEN_EVENT,
  processingRestricted: PROCESSING_RESTRICTED_EVENT,
  processingRestrictionLifted: PROCESSING_RESTRICTION_LIFTED_EVENT,
};
