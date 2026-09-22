import type { EventListener, EventNotifier } from "../adapter/ports/event-notifier.ts";

/**
 * A notifier for the in-memory adapter: `notify` fans out to every subscribed listener in the
 * same process. What the memory event store calls after an append.
 */
export interface MemoryEventNotifier extends EventNotifier {
  notify(position: number): void;
}

export interface CreateMemoryEventNotifierFunction {
  (): MemoryEventNotifier;
}

export const createMemoryEventNotifier: CreateMemoryEventNotifierFunction = () => {
  const listeners = new Set<EventListener>();
  return {
    subscribe: async (listener) => {
      listeners.add(listener);
      return async () => {
        listeners.delete(listener);
      };
    },
    notify: (position) => {
      for (const listener of listeners) listener(position);
    },
  };
};
