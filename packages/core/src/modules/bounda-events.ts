import type { StoredEvent } from "../contracts/event.ts";

/**
 * The aggregate the runtime's own events belong to, one stream per subject: a read model
 * projects them from `projections/bounda/<event>.ts`, and a policy reacts to them from
 * `policies/bounda/<action>-on-<event>.ts`. No aggregate of the app can take the name.
 */
export const BOUNDA_AGGREGATE: "bounda" = "bounda";

/**
 * Appended by `forget(personId)` to the stream `bounda:<personId>`, once the person's key is
 * gone: every event's personal field of theirs reads as `null` from then on, and every read model
 * that projects such fields handles it. It names the stored commands that held the person's data
 * and went with the key, since no other event records them.
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

export interface PersonalDataForgottenPayload {
  readonly personId: string;
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
