import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredDispatch } from "../../contracts/command.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import {
  BOUNDA_AGGREGATE,
  PERSONAL_DATA_FORGOTTEN_EVENT,
  type PersonalDataForgottenPayload,
  type PersonalDataForgottenReason,
} from "../../modules/bounda-events.ts";
import type { ForgetOptions, PersonalCategoryName } from "../../modules/personal-data.ts";
import { scheduledCommandId } from "../command/pipeline.ts";
import { actedBy, startedBy } from "../shared/causation.ts";
import { appendSystemEvent } from "../system-events.ts";
import { lastActivity } from "./activity.ts";
import type { PersonalCategories } from "./categories.ts";
import { checkPersonId, transactRetrying } from "./transact.ts";

/**
 * What a forgetting covers: the person as a whole, some of their categories, or, for a category's
 * retention, some of their keys by fingerprint.
 */
export type ForgetScope =
  | { readonly kind: "whole" }
  | { readonly kind: "categories"; readonly categories: readonly string[] }
  | { readonly kind: "keys"; readonly fingerprints: readonly string[] };

export interface ForgetWithinArgs {
  readonly transaction: StorageTransaction;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly personId: string;
  readonly reason: PersonalDataForgottenReason;
  readonly context: CausationContext;
  readonly categories: PersonalCategories;
  readonly scope: ForgetScope;
  /**
   * How many events a read of the person's last activity takes at once.
   */
  readonly batchSize: number;
}

export interface Forgotten {
  /**
   * How many keys went for good.
   */
  readonly destroyed: number;
  readonly payload: PersonalDataForgottenPayload;
  readonly event: StoredEvent;
}

export interface ForgetWithinFunction {
  (args: ForgetWithinArgs): Promise<Forgotten>;
}

// A key in force of a category under a legal obligation outlives a request while its retention
// runs from the person's last activity, read past what the retention recorded so it is never cut
// short; a person never seen active is taken as active now.
const keptUntil = async (
  args: ForgetWithinArgs,
  retentionMs: number,
  activity: () => Promise<string | null>,
): Promise<{ readonly lastActiveAt: string; readonly until: number }> => {
  const lastActiveAt = (await activity()) ?? args.clock.now().toISOString();
  return { lastActiveAt, until: Date.parse(lastActiveAt) + retentionMs };
};

/**
 * Forgets what `scope` covers on the transaction given, and appends `PersonalDataForgotten` to the
 * person's stream: whoever reads the event finds the fields gone already. A key in force of a
 * category whose basis is a legal obligation is retained instead while its retention has not run
 * out, when the person or the category is what was asked for; a key named by fingerprint goes
 * whatever it is. The scheduled commands, dead letters, snapshots and remembered rejections that
 * hold the person's data under a key no longer in force go in the same transaction, every one
 * that names them when they are forgotten as a whole, and the event names the commands and the
 * letters. A person without a key is forgotten all the same, since read models may hold what
 * their events carried in the clear.
 */
export const forgetWithin: ForgetWithinFunction = async (args) => {
  const { transaction, ids, clock, personId, reason, context, categories, scope } = args;
  const now = clock.now();
  const held = await transaction.personalKeys.list(personId);
  const inForce = held.filter(({ retainedSince }) => retainedSince === null);
  const asked =
    scope.kind === "keys"
      ? held.filter(({ key }) => scope.fingerprints.includes(key.fingerprint))
      : inForce.filter(
          ({ category }) => scope.kind === "whole" || scope.categories.includes(category),
        );
  let activity: Promise<string | null> | undefined;
  const lastActive = (): Promise<string | null> => {
    activity ??= lastActivity({
      persons: transaction.persons,
      eventStore: transaction.eventStore,
      person: personId,
      batchSize: args.batchSize,
    });
    return activity;
  };
  // The key goes first: a snapshot written beside the transaction then either waits for it and
  // is forgotten with the rest, or finds no key in force and is never written. The scheduled
  // commands go before the dead letters: a worker giving one up writes its letter and settles its
  // claim together, so either this waits for it and then finds the letter, or the claim is lost
  // and the letter rolls back.
  const gone = new Set<string>();
  const expired = new Set<string>();
  let destroyed = 0;
  for (const { category, key, retainedSince } of asked) {
    const basis = categories.of(category);
    if (
      scope.kind !== "keys" &&
      basis?.basis === "legal-obligation" &&
      basis.retentionMs !== null
    ) {
      const kept = await keptUntil(args, basis.retentionMs, lastActive);
      if (kept.until > now.getTime()) {
        await transaction.personalKeys.retain(personId, key.fingerprint, {
          since: now.toISOString(),
          lastActiveAt: kept.lastActiveAt,
        });
        continue;
      }
    }
    if (await transaction.personalKeys.remove(personId, key.fingerprint)) destroyed += 1;
    (retainedSince === null ? gone : expired).add(category);
  }
  // A forgetting as a whole leaves no key in force, so it keeps nothing.
  const after = await transaction.personalKeys.list(personId);
  const keep = after
    .filter(({ retainedSince }) => retainedSince === null)
    .map(({ key }) => key.fingerprint);
  const retainedAfter = new Set(
    after.filter(({ retainedSince }) => retainedSince !== null).map(({ category }) => category),
  );
  await transaction.snapshotStore.forget(personId, keep);
  await transaction.idempotencyStore.forget(personId, keep);
  const cancelled = await transaction.scheduler.forget(personId, keep);
  const letters = await transaction.deadLetterStore.forget(personId, keep);
  const named: readonly string[] =
    scope.kind === "whole"
      ? categories.all.map(({ name }) => name)
      : scope.kind === "categories"
        ? scope.categories
        : [...gone];
  const payload: PersonalDataForgottenPayload = {
    personId,
    reason,
    whole: scope.kind === "whole",
    categories: named.filter(
      (category) => !retainedAfter.has(category) || gone.has(category),
    ) as PersonalCategoryName[],
    retained: (scope.kind === "keys"
      ? []
      : named.filter((category) => retainedAfter.has(category))) as PersonalCategoryName[],
    expired: [...expired] as PersonalCategoryName[],
    cancelledCommands: cancelled.map(({ dedupeKey, command }) => ({
      commandId: scheduledCommandId(dedupeKey) ?? dedupeKey,
      type: command.type,
    })),
    removedDeadLetters: letters.map(({ id, handler }) => ({ id, commandType: handler })),
  };
  const event = await appendSystemEvent({
    eventStore: transaction.eventStore,
    ids,
    clock,
    aggregateType: BOUNDA_AGGREGATE,
    aggregateId: personId,
    type: PERSONAL_DATA_FORGOTTEN_EVENT,
    payload,
    context,
    person: personId,
  });
  return { destroyed, payload, event };
};

export interface RequestedCategoriesFunction {
  (payload: PersonalDataForgottenPayload): readonly string[] | null;
}

/**
 * What a forgetting asked for, as the ledger keeps it to forget the person again: `null` for the
 * person as a whole, else the categories named, those retained included. A forgetting of what an
 * earlier one retained asked for nothing: the retention ends that again on its own.
 */
export const requestedCategories: RequestedCategoriesFunction = (payload) =>
  payload.whole === false ? [...payload.categories, ...payload.retained] : null;

export interface LogForgottenFunction {
  (logger: Logger, forgotten: Forgotten): void;
}

export const logForgotten: LogForgottenFunction = (logger, { destroyed, payload, event }) => {
  logger.info("personal data forgotten", {
    personId: payload.personId,
    reason: payload.reason,
    whole: payload.whole,
    categories: payload.categories,
    retained: payload.retained,
    expired: payload.expired,
    destroyedKeys: destroyed,
    cancelledCommands: payload.cancelledCommands.length,
    removedDeadLetters: payload.removedDeadLetters.length,
    ...actedBy(event.metadata.actor),
  });
};

export interface ForgottenDispatchFunction {
  (event: StoredEvent): StoredDispatch;
}

export const forgottenDispatch: ForgottenDispatchFunction = (event) => ({
  scheduled: false,
  aggregateType: BOUNDA_AGGREGATE,
  aggregateId: event.aggregateId,
  version: event.version,
  eventIds: [event.id],
  eventTypes: [event.type],
  position: event.position,
});

export interface ForgetPersonalDataArgs {
  readonly storage: Storage;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly concurrencyRetries: number;
  readonly categories: PersonalCategories;
  readonly batchSize: number;
  readonly personId: string;
  readonly options?: ForgetOptions | undefined;
  readonly actor?: string | undefined;
}

export interface ForgetPersonalDataFunction {
  (args: ForgetPersonalDataArgs): Promise<StoredDispatch>;
}

export interface ForgetScopeOfArgs {
  readonly categories: PersonalCategories;
  readonly options: ForgetOptions | undefined;
}

export interface ForgetScopeOfFunction {
  (args: ForgetScopeOfArgs): ForgetScope;
}

/**
 * The scope of `forget(personId, options)`: the person as a whole without `categories`. Throws
 * `ValidationError` for categories that are empty or that the app does not have.
 */
export const forgetScopeOf: ForgetScopeOfFunction = ({ categories, options }) => {
  if (options?.categories === undefined) return { kind: "whole" };
  const asked: unknown = options.categories;
  if (!Array.isArray(asked) || asked.length === 0) {
    throw new ValidationError("forget needs at least one category when it names them", [
      { path: ["categories"], message: "Expected a non-empty array of categories" },
    ]);
  }
  const unknown = asked.filter(
    (category) => typeof category !== "string" || categories.of(category) === undefined,
  );
  if (unknown.length > 0) {
    throw new ValidationError(
      `forget names categories the app does not have: ${unknown.map((category) => JSON.stringify(category)).join(", ")}`,
      [
        {
          path: ["categories"],
          message: 'Expected categories app/personal-data.ts declares, or "default"',
        },
      ],
    );
  }
  return { kind: "categories", categories: [...new Set(asked as string[])] };
};

/**
 * `forget` of a client: `forgetWithin` in a transaction of its own, as a request of the person.
 */
export const forgetPersonalData: ForgetPersonalDataFunction = async ({
  storage,
  ids,
  clock,
  logger,
  concurrencyRetries,
  categories,
  batchSize,
  personId,
  options,
  actor,
}) => {
  checkPersonId(personId, "forget");
  const scope = forgetScopeOf({ categories, options });
  const correlationId = ids.next();
  const forgotten = await transactRetrying({
    storage,
    concurrencyRetries,
    work: (transaction) =>
      forgetWithin({
        transaction,
        ids,
        clock,
        personId,
        reason: "requested",
        context: startedBy(correlationId, actor),
        categories,
        scope,
        batchSize,
      }),
  });
  logForgotten(logger, forgotten);
  return forgottenDispatch(forgotten.event);
};
