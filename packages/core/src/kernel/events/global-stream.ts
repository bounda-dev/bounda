import type { EventStore } from "../../adapter/storage/event-store.ts";
import { ValidationError, type ValidationIssue } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

export interface ReadEventsArgs {
  /**
   * The position to read after. Defaults to 0, the start of the stream; the position of the last
   * event a read returned reads on from there.
   */
  readonly after?: number;
  /**
   * At most this many events, from 1 to 1,000. Defaults to 100.
   */
  readonly limit?: number;
}

/**
 * The store's global stream, read by position: what an operator's console, an audit trail or a
 * page that follows the stream needs. Payloads come whole, personal data included, so it is for
 * those who operate the app, never for the public as it is.
 */
export interface GlobalStream {
  /**
   * The events committed after `after`, in the order of their position: every aggregate's, and
   * the lifecycle events of every process, whose `aggregateType` is
   * `process:<aggregate>.<process>`. Each comes as it was stored, its payload in the shape
   * `metadata.schemaVersion` names, without the upcasts handlers see. An empty result means
   * nothing past `after` is committed yet: polling from the last position returned never misses an
   * event committed later. Rejects with `ValidationError` an `after` or a `limit` out of range.
   */
  read(args?: ReadEventsArgs): Promise<readonly StoredEvent[]>;
}

export interface CreateGlobalStreamArgs {
  /**
   * The store as written, not the upcasting one handlers read through.
   */
  readonly eventStore: EventStore;
}

export interface CreateGlobalStreamFunction {
  (args: CreateGlobalStreamArgs): GlobalStream;
}

const isWhole = (value: number, min: number, max = Number.MAX_SAFE_INTEGER): boolean =>
  Number.isSafeInteger(value) && value >= min && value <= max;

export const createGlobalStream: CreateGlobalStreamFunction = ({ eventStore }) => ({
  // `null` too, which a Worker may pass on from a JSON body.
  read: async (args) => {
    const { after = 0, limit = DEFAULT_LIMIT } = args ?? {};
    const issues: ValidationIssue[] = [];
    if (!isWhole(after, 0)) {
      issues.push({ path: ["after"], message: "Expected a position: a whole number from 0" });
    }
    if (!isWhole(limit, 1, MAX_LIMIT)) {
      issues.push({ path: ["limit"], message: `Expected a whole number from 1 to ${MAX_LIMIT}` });
    }
    if (issues.length > 0) throw new ValidationError("Invalid read of the global stream", issues);
    return eventStore.readAll({ afterPosition: after, limit });
  },
});
