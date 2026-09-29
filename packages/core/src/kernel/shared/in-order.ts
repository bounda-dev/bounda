import type { StoredEvent } from "../../contracts/event.ts";
import { qualifiedEventType } from "./qualified-event.ts";

/**
 * How one reaction to one event went: `done` when the event is behind it, `hold` when it must be
 * delivered again before the reaction's later events.
 */
export type ReactionOutcome = "done" | "hold";

export interface DeliverInOrderArgs<Reaction extends { readonly name: string }> {
  readonly events: readonly StoredEvent[];
  readonly byEvent: Readonly<Record<string, readonly Reaction[]>>;
  readonly deliver: (reaction: Reaction, event: StoredEvent) => Promise<ReactionOutcome>;
}

export interface DeliverInOrderFunction {
  <Reaction extends { readonly name: string }>(args: DeliverInOrderArgs<Reaction>): Promise<number>;
}

/**
 * Resolves to how many leading events every reaction is done with. Once a reaction holds an event,
 * its later events of the batch are skipped, so none of them overtakes it.
 */
export const deliverInOrder: DeliverInOrderFunction = async ({ events, byEvent, deliver }) => {
  const held = new Set<string>();
  let done = events.length;
  for (const [index, event] of events.entries()) {
    for (const reaction of byEvent[qualifiedEventType(event.aggregateType, event.type)] ?? []) {
      if (held.has(reaction.name)) continue;
      if ((await deliver(reaction, event)) === "hold") {
        held.add(reaction.name);
        done = Math.min(done, index);
      }
    }
  }
  return done;
};
