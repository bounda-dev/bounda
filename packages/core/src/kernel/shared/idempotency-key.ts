import { v5 as uuidV5 } from "uuid";

const NAMESPACE = "55684f7b-5682-4a97-837e-a64a7c205ba5";

interface ReactionIdentity {
  /**
   * Whether the handler is a policy's or a process's: their names can be equal.
   */
  readonly kind: "policy" | "process";
  /**
   * A policy or process name, e.g. `order.chargeOnOrderPlaced`.
   */
  readonly handler: string;
}

export interface DeriveIdempotencyKeyArgs extends ReactionIdentity {
  /**
   * What the handler is running for: the event id, or `<instance>:deadline:<field>:<moment>` for a
   * process deadline.
   */
  readonly subject: string;
  /**
   * Set when an operator retries a dead letter, so the provider sees a new request instead of
   * answering with the outcome it stored for the failed one.
   */
  readonly retryId?: string | undefined;
}

export interface DeriveIdempotencyKeyFunction {
  (args: DeriveIdempotencyKeyArgs): string;
}

/**
 * The key a reaction hands to the providers it calls. A UUID v5, so it is the same on every
 * automatic retry of one run and 36 characters long, which every provider accepts.
 */
export const deriveIdempotencyKey: DeriveIdempotencyKeyFunction = ({
  kind,
  handler,
  subject,
  retryId,
}) =>
  uuidV5(
    [kind, handler, subject, ...(retryId === undefined ? [] : ["retry", retryId])].join(":"),
    NAMESPACE,
  );

export interface DeriveDeadLetterIdArgs extends ReactionIdentity {
  /**
   * The event the reaction gave up on.
   */
  readonly subject: string;
}

export interface DeriveDeadLetterIdFunction {
  (args: DeriveDeadLetterIdArgs): string;
}

/**
 * The id of the one dead letter a claimed reaction files when it gives up on an event: a UUID v5
 * of kind, handler and subject, so filing it again after a crash finds the letter already there.
 */
export const deriveDeadLetterId: DeriveDeadLetterIdFunction = ({ kind, handler, subject }) =>
  uuidV5([kind, handler, subject, "dead-letter"].join(":"), NAMESPACE);

export interface CreateReactionCommandIdsFunction {
  (idempotencyKey: string): (commandType: string) => string;
}

/**
 * Ids for the commands one run of a reaction dispatches: a UUID v5 of its idempotency key, the
 * command type and how many commands of that type the run dispatched before. A retry that
 * dispatches the same commands gives them the same ids, so a scheduled one is stored once.
 */
export const createReactionCommandIds: CreateReactionCommandIdsFunction = (idempotencyKey) => {
  const dispatched = new Map<string, number>();
  return (commandType) => {
    const ordinal = dispatched.get(commandType) ?? 0;
    dispatched.set(commandType, ordinal + 1);
    return uuidV5([idempotencyKey, "command", commandType, ordinal].join(":"), NAMESPACE);
  };
};

export interface IdempotencyKeyForFunction {
  (idempotencyKey: string, effect: string): string;
}

/**
 * A key of its own for one of the effects a handler run causes, when it causes more than one
 * (a refund and a charge), or the id of an aggregate a reaction creates (a payment): give each a
 * different name. Derived from any key, the handler's or one a port received, it is the
 * same for one name on every retry and in every release, and a UUID as long as the handler's own
 * key, whatever the length of the name.
 */
export const idempotencyKeyFor: IdempotencyKeyForFunction = (idempotencyKey, effect) =>
  // JSON keeps a separator inside the key or the name from making two pairs hash alike.
  uuidV5(JSON.stringify([idempotencyKey, "effect", effect]), NAMESPACE);
