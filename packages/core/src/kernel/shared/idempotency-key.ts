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

export interface CreateReactionCommandIdsFunction {
  (idempotencyKey: string): (commandType: string) => string;
}

/**
 * Ids for the commands one run of a reaction dispatches: a UUID v5 of its idempotency key, the
 * command type and how many commands of that type the run dispatched before. A retry that
 * dispatches the same commands gives them the same ids, so a delayed one is scheduled once.
 */
export const createReactionCommandIds: CreateReactionCommandIdsFunction = (idempotencyKey) => {
  const dispatched = new Map<string, number>();
  return (commandType) => {
    const ordinal = dispatched.get(commandType) ?? 0;
    dispatched.set(commandType, ordinal + 1);
    return uuidV5([idempotencyKey, "command", commandType, ordinal].join(":"), NAMESPACE);
  };
};
