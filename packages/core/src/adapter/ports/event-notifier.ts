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
 * An adapter's way of saying "there are new events" without being asked. The dispatcher runs a
 * pass when the listener fires instead of waiting for its next poll, and while an app has one it
 * polls only as a safety net, every `runtime.dispatcher.idleInterval`. Optional: an adapter that
 * cannot push, such as SQLite, leaves it out and the dispatcher polls at `pollInterval` as before.
 * Notifications may be lost or coalesced; delivery is what the poll guarantees.
 */
export interface EventNotifier {
  subscribe(listener: EventListener): Promise<Unsubscribe>;
}
