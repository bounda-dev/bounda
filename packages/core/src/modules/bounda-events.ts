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
 * that projects such fields handles it.
 */
export const PERSONAL_DATA_FORGOTTEN_EVENT: "PersonalDataForgotten" = "PersonalDataForgotten";

export interface PersonalDataForgottenPayload {
  readonly personId: string;
}

export type PersonalDataForgottenEvent = StoredEvent<
  typeof PERSONAL_DATA_FORGOTTEN_EVENT,
  PersonalDataForgottenPayload
>;

/**
 * The runtime's events, by the key a module's file name gives them.
 */
export const BOUNDA_EVENTS: Readonly<Record<string, string>> = {
  personalDataForgotten: PERSONAL_DATA_FORGOTTEN_EVENT,
};
