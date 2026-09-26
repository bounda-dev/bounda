import { v5 as uuidV5 } from "uuid";

const NAMESPACE = "55684f7b-5682-4a97-837e-a64a7c205ba5";

export interface DeriveIdempotencyKeyArgs {
  /**
   * Whether the handler is a policy's or a process's: their names can be equal.
   */
  readonly kind: "policy" | "process";
  /**
   * The handler that makes the call: a policy or process name.
   */
  readonly handler: string;
  /**
   * What the handler is running for: the event id, or the process instance for a timeout.
   */
  readonly subject: string;
  /**
   * Set when an operator replays a dead letter, so the provider sees a new request instead of
   * answering with the outcome it stored for the failed one.
   */
  readonly replay?: string | undefined;
}

export interface DeriveIdempotencyKeyFunction {
  (args: DeriveIdempotencyKeyArgs): string;
}

/**
 * The key a reaction hands to the providers it calls: a UUID v5 of kind, handler, subject and replay,
 * the same on every automatic retry of one run and 36 characters long, which every provider
 * accepts.
 */
export const deriveIdempotencyKey: DeriveIdempotencyKeyFunction = ({
  kind,
  handler,
  subject,
  replay,
}) =>
  uuidV5(
    [kind, handler, subject, ...(replay === undefined ? [] : ["replay", replay])].join(":"),
    NAMESPACE,
  );
