/**
 * One step of an event's schema history: turns the payload as version `n` stored it into the
 * payload of version `n + 1`. Pure, synchronous, and never sees the stored event's metadata.
 */
export type Upcast<From, To> = (payload: From) => To;

/**
 * The `upcasts` export of `<event>.upcast.ts`: one function per schema version the event has had,
 * oldest first, the last one producing the payload the event has today. An event with `n`
 * upcasts is written with `schemaVersion` `n + 1`, and a stored event with version `v` is passed
 * through the upcasts from index `v - 1` on when it is read.
 *
 * Only the last step is checked against the current payload type: TypeScript cannot follow the
 * chain, so each step's input is what the step before returns and nothing more.
 */
export type Upcasts<Final> = readonly [...Upcast<never, unknown>[], Upcast<never, Final>];

/**
 * The shape of `<event>.upcast.ts`.
 */
export interface UpcastsModule {
  readonly upcasts: Upcasts<unknown>;
}
