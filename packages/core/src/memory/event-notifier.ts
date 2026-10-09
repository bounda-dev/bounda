import type { EventListener, EventNotifier } from "../adapter/storage/event-notifier.ts";

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
