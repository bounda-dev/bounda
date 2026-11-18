import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredDispatch } from "../../contracts/command.ts";
import { type Retention, retentionEnd } from "../../contracts/duration.ts";
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
import type {
  ErasureExemption,
  ForgetOptions,
  PersonalCategoryName,
} from "../../modules/personal-data.ts";
import { scheduledCommandId } from "../command/pipeline.ts";
import { addressed } from "../recipients/addressing.ts";
import { actedBy, startedBy } from "../shared/causation.ts";
import { appendSystemEvent } from "../system-events.ts";
import { lastActivity } from "./activity.ts";
import {
  checkCategoryNames,
  type PersonalCategories,
  type PersonalCategory,
} from "./categories.ts";
import { objectable } from "./information.ts";
import {
  coveredBy,
  type EndsKeptFunction,
  type ForgetIntention,
  type ForgetIntentions,
} from "./intention.ts";
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
  readonly intention: ForgetIntention;
  readonly context: CausationContext;
  readonly categories: PersonalCategories;
  readonly scope: ForgetScope;
  /**
   * How many events a read of the person's last activity takes at once.
   */
  readonly batchSize: number;
  /**
   * The caller found already, in this transaction, the intention's event not held and a key the
   * scope covers named by it.
   */
  readonly checked?: boolean;
}

export interface Forgotten {
  /**
   * How many keys went for good.
   */
  readonly destroyed: number;
  readonly payload: PersonalDataForgottenPayload;
  readonly event: StoredEvent;
}

/**
 * The forgetting the intention names is in the store already, committed by a reconciliation
 * meanwhile.
 */
export interface HeldForgetting {
  readonly held: StoredEvent;
}

// What an upheld objection leaves to keep: data an obligation of law requires, and what legal
// claims need, which article 21(1) spares; the other exemptions rest on the very processing the
// person objected to.
const SURVIVE_OBJECTION: readonly ErasureExemption[] = ["legal-obligation", "legal-claims"];

export interface KeepsFunction {
  (category: PersonalCategory, reason: PersonalDataForgottenReason): boolean;
}

/**
 * Whether a forgetting for `reason` keeps the category's keys in force, under an exemption of
 * article 17(3).
 */
export const keeps: KeepsFunction = (category, reason) =>
  reason === "objection" && objectable(category)
    ? category.exemptions.some((exemption) => SURVIVE_OBJECTION.includes(exemption))
    : category.exemptions.length > 0;

export interface EndsKeptOfFunction {
  (
    categories: PersonalCategories,
    reason: PersonalDataForgottenReason | undefined,
  ): EndsKeptFunction;
}

/**
 * What an earlier forgetting kept that a forgetting for `reason` ends: after an objection, what no
 * exemption it spares keeps of a category it reaches.
 */
export const endsKeptOf: EndsKeptOfFunction = (categories, reason) => (name) => {
  const category = categories.of(name);
  return (
    reason === "objection" &&
    category !== undefined &&
    objectable(category) &&
    !keeps(category, reason)
  );
};

// A key in force of a category an erasure exemption keeps outlives a request while its retention
// runs from the person's last activity, read past what the retention recorded so it is never cut
// short; a person never seen active is taken as active now.
const keptUntil = async (
  args: ForgetWithinArgs,
  retention: Retention,
  activity: () => Promise<string | null>,
): Promise<{ readonly lastActiveAt: string; readonly until: number }> => {
  const lastActiveAt = (await activity()) ?? args.clock.now().toISOString();
  return { lastActiveAt, until: retentionEnd(Date.parse(lastActiveAt), retention) };
};

/**
 * The person holds a key the intention does not name: given to them after it was written.
 */
export const STALE_INTENTION: "stale" = "stale";

export type ForgetOutcome = Forgotten | HeldForgetting | typeof STALE_INTENTION;

export interface ForgetWithinFunction {
  (args: ForgetWithinArgs): Promise<ForgetOutcome>;
}

/**
 * Forgets what `scope` covers on the transaction given, and appends `PersonalDataForgotten` to the
 * person's stream, with the id, time and reason of the intention: whoever reads the event finds
 * the fields gone already. A key in force of a category an erasure exemption keeps is retained
 * instead while its retention has not run out, when the person or the category is what was asked
 * for, and after an objection a key kept earlier that no exemption it spares keeps goes; a key
 * named by fingerprint goes whatever it is. The scheduled commands, dead letters and snapshots
 * that hold the person's data under a key no longer in force go in the same transaction, and the
 * remembered answers sealed under one are erased, every one that names them when they are
 * forgotten as a whole; the event names the commands and the letters. A person without a key is
 * forgotten all the same, since read models may hold what their events carried in the clear.
 */
export const forgetWithin: ForgetWithinFunction = async (args) => {
  const { transaction, ids, clock, personId, intention, context, categories, scope } = args;
  const { checked = false } = args;
  const { fingerprints } = intention;
  if (fingerprints !== undefined && !checked) {
    const applied = await transaction.eventStore.readOne({
      aggregateType: BOUNDA_AGGREGATE,
      aggregateId: personId,
      eventId: intention.eventId,
    });
    if (applied !== null) return { held: applied };
  }
  const now = clock.now();
  // A key the scope covers that the intention does not name was given to the person after it: a
  // caller that checked the intention already keeps it.
  const covered = coveredBy(
    scope,
    await transaction.personalKeys.list(personId),
    endsKeptOf(categories, intention.reason),
  );
  const asked = covered.filter(
    ({ key }) => fingerprints === undefined || fingerprints.includes(key.fingerprint),
  );
  if (!checked && asked.length < covered.length) return STALE_INTENTION;
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
  // The keys a reseal replaced by those asked go with them, and are named with them: a read model
  // not rebuilt since, or a copy restored from before the reseal, holds them.
  const replaced = await transaction.personalKeys.predecessors(
    personId,
    asked.map(({ key }) => key.fingerprint),
  );
  const gone = new Set<string>();
  const expired = new Set<string>();
  let destroyed = 0;
  for (const { category, key, retainedSince } of asked) {
    const declared = categories.of(category);
    if (scope.kind !== "keys" && declared?.retention != null && keeps(declared, intention.reason)) {
      const kept = await keptUntil(args, declared.retention, lastActive);
      if (kept.until > now.getTime()) {
        await transaction.personalKeys.retain(personId, key.fingerprint, {
          since: now.toISOString(),
          lastActiveAt: kept.lastActiveAt,
        });
        continue;
      }
    }
    if (await transaction.personalKeys.remove(personId, key.fingerprint)) destroyed += 1;
    // What an objection ends of an earlier forgetting is forgotten now, not expired.
    (retainedSince === null || scope.kind !== "keys" ? gone : expired).add(category);
  }
  // A forgetting as a whole keeps nothing, unless a caller that checked its intention left a key
  // given after it in force; that key's category is then neither whole nor forgotten.
  const after = await transaction.personalKeys.list(personId);
  const inForce = after.filter(({ retainedSince }) => retainedSince === null);
  const inForceKeys = inForce.map(({ key }) => key.fingerprint);
  const keep = [
    ...inForceKeys,
    ...(await transaction.personalKeys.predecessors(personId, inForceKeys)),
  ];
  const inForceAfter = new Set(inForce.map(({ category }) => category));
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
    reason: intention.reason,
    whole: scope.kind === "whole" && inForceKeys.length === 0,
    categories: named.filter(
      (category) =>
        gone.has(category) || (!retainedAfter.has(category) && !inForceAfter.has(category)),
    ) as PersonalCategoryName[],
    retained: (scope.kind === "keys"
      ? []
      : named.filter((category) => retainedAfter.has(category))) as PersonalCategoryName[],
    expired: [...expired] as PersonalCategoryName[],
    fingerprints: [...asked.map(({ key }) => key.fingerprint), ...replaced],
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
    payload: await addressed(transaction, { type: PERSONAL_DATA_FORGOTTEN_EVENT, payload }),
    context,
    person: personId,
    identity: { id: intention.eventId, timestamp: intention.forgottenAt },
  });
  return { destroyed, payload, event };
};

export interface ForgetIntendedArgs {
  readonly storage: Pick<Storage, "transact" | "personalKeys">;
  readonly intentions: ForgetIntentions;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly concurrencyRetries: number;
  readonly categories: PersonalCategories;
  readonly batchSize: number;
  readonly personId: string;
  readonly scope: ForgetScope;
  readonly reason: PersonalDataForgottenReason;
  readonly context: CausationContext;
}

export interface ForgetIntendedFunction {
  (args: ForgetIntendedArgs): Promise<Forgotten | HeldForgetting>;
}

/**
 * Records the intention, then forgets in a transaction of its own. A key given to the person
 * between the two takes a new intention that names it: each round needs a forgetting of the same
 * person to commit in between, so the rounds end when those do.
 */
export const forgetIntended: ForgetIntendedFunction = async ({
  storage,
  intentions,
  ids,
  clock,
  concurrencyRetries,
  categories,
  batchSize,
  personId,
  scope,
  reason,
  context,
}) => {
  for (;;) {
    const intention = await intentions.intend({
      personId,
      reason,
      scope,
      ends: endsKeptOf(categories, reason),
      keys: storage.personalKeys,
    });
    const outcome = await transactRetrying({
      storage,
      concurrencyRetries,
      work: (transaction) =>
        forgetWithin({
          transaction,
          ids,
          clock,
          personId,
          intention,
          context,
          categories,
          scope,
          batchSize,
        }),
    });
    if (outcome !== STALE_INTENTION) return outcome;
  }
};

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
  readonly intentions: ForgetIntentions;
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
export const forgetScopeOf: ForgetScopeOfFunction = ({ categories, options }) =>
  options?.categories === undefined
    ? { kind: "whole" }
    : {
        kind: "categories",
        categories: checkCategoryNames({
          categories,
          asked: options.categories,
          operation: "forget",
        }),
      };

export interface ForgetReasonOfFunction {
  (options: ForgetOptions | undefined): PersonalDataForgottenReason;
}

/**
 * The reason `forget(personId, options)` records: `objection` with `objection: true`. Throws
 * `ValidationError` for an `objection` that is not a boolean.
 */
export const forgetReasonOf: ForgetReasonOfFunction = (options) => {
  const objection = options?.objection;
  if (objection !== undefined && typeof objection !== "boolean") {
    throw new ValidationError("forget takes objection as true or false", [
      { path: ["objection"], message: "Expected a boolean" },
    ]);
  }
  return objection === true ? "objection" : "requested";
};

/**
 * `forget` of a client: `forgetIntended`, as a request of the person or after their objection.
 */
export const forgetPersonalData: ForgetPersonalDataFunction = async ({
  storage,
  intentions,
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
  const reason = forgetReasonOf(options);
  const correlationId = ids.next();
  const forgotten = await forgetIntended({
    storage,
    intentions,
    ids,
    clock,
    concurrencyRetries,
    categories,
    batchSize,
    personId,
    scope,
    reason,
    context: startedBy(correlationId, actor),
  });
  if ("held" in forgotten) return forgottenDispatch(forgotten.held);
  logForgotten(logger, forgotten);
  return forgottenDispatch(forgotten.event);
};
