export interface EventListener {
  /**
   * Called after events were committed. `position` is the global position of the last event the
   * notification is about when the adapter knows it.
   */
  (position?: number): void;
}

export interface Unsubscribe {
  (): Promise<void>;
}

/**
 * Lets an adapter push "there are new events", so the dispatcher passes at once instead of at its
 * next poll. Optional. Notifications may be lost or coalesced: the poll, which an idle dispatcher
 * with a notifier stretches to `runtime.dispatcher.idleInterval`, is what guarantees delivery.
 */
export interface EventNotifier {
  subscribe(listener: EventListener): Promise<Unsubscribe>;
}
