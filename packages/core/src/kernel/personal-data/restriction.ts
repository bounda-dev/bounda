import type { Storage, StorageTransaction } from "../../adapter/adapter.ts";
import type { ForgetLedgerEntry, LedgerRestriction } from "../../adapter/storage/forget-ledger.ts";
import type { StoredRestriction } from "../../adapter/storage/person-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { StoredDispatch } from "../../contracts/command.ts";
import { parseDuration } from "../../contracts/duration.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import {
  BOUNDA_AGGREGATE,
  PROCESSING_RESTRICTED_EVENT,
  PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT,
  PROCESSING_RESTRICTION_LIFTED_EVENT,
} from "../../modules/bounda-events.ts";
import {
  type PersonalCategoryName,
  type ProcessingRestriction,
  RESTRICTION_GROUNDS,
  type RestrictionGround,
  type RestrictionNotice,
  type RestrictOptions,
  type UnrestrictOptions,
} from "../../modules/personal-data.ts";
import { RETRY_RESTRICTED_COMMAND, retryRestrictedKey } from "../command/pipeline.ts";
import { actedBy, causedBy, startedBy } from "../shared/causation.ts";
import { appendSystemEvent } from "../system-events.ts";
import { type CategoryNames, checkCategoryNames } from "./categories.ts";
import type { ForgetIntentions } from "./intention.ts";
import { checkPersonId, transactRetrying } from "./transact.ts";

const LIFT_RESTRICTION_PREFIX = "lift-restriction:";

/**
 * The scheduler command type of the runtime's entry that lifts an announced restriction once its
 * notice has run. Not a user command: the worker runs it itself.
 */
export const LIFT_RESTRICTION_COMMAND: "bounda.LiftRestriction" = "bounda.LiftRestriction";

export interface LiftRestrictionKeyFunction {
  (personId: string, ground: RestrictionGround, category: string | null): string;
}

/**
 * The scheduler's dedupe key of that entry, one per person, ground and category, `null` for the
 * whole ground: announcing the same lift again replaces it, announcing another adds one, and
 * restricting again on the ground cancels them.
 */
export const liftRestrictionKey: LiftRestrictionKeyFunction = (personId, ground, category) =>
  `${LIFT_RESTRICTION_PREFIX}${JSON.stringify([personId, ground, category])}`;

/**
 * The payload of that entry.
 */
export interface LiftRestrictionPayload {
  readonly personId: string;
  readonly ground: RestrictionGround;
  readonly categories: readonly string[] | null;
}

export interface ProcessingRestrictionsOfFunction {
  (rows: readonly StoredRestriction[]): readonly ProcessingRestriction[];
}

/**
 * A person's restriction rows as the events and the export say them: one per ground, with the
 * categories it covers, `null` for the person as a whole, since its oldest row.
 */
export const processingRestrictionsOf: ProcessingRestrictionsOfFunction = (rows) => {
  const byGround = new Map<RestrictionGround, StoredRestriction[]>();
  for (const row of rows) byGround.set(row.ground, [...(byGround.get(row.ground) ?? []), row]);
  return RESTRICTION_GROUNDS.flatMap((ground) => {
    const of = byGround.get(ground);
    if (of === undefined) return [];
    const since = of.map((row) => row.since).sort()[0] as string;
    const categories = of.some((row) => row.category === null)
      ? null
      : (of.map((row) => row.category as PersonalCategoryName).sort() as PersonalCategoryName[]);
    return [{ ground, categories, since }];
  });
};

// What the store's `restrict` leaves, `null` when it would change nothing: the rows an intention
// is written for before the transaction reads them again.
const restricted = (
  rows: readonly StoredRestriction[],
  ground: RestrictionGround,
  categories: readonly string[] | null,
  since: string,
): readonly StoredRestriction[] | null => {
  const on = rows.filter((row) => row.ground === ground);
  if (on.some((row) => row.category === null)) return null;
  if (categories === null) {
    return [...rows.filter((row) => row.ground !== ground), { ground, category: null, since }];
  }
  const added = categories
    .filter((category) => !on.some((row) => row.category === category))
    .map((category) => ({ ground, category, since }));
  return added.length === 0 ? null : [...rows, ...added];
};

const matches =
  (ground: RestrictionGround | undefined, categories: readonly string[] | null) =>
  (row: StoredRestriction): boolean =>
    (ground === undefined || row.ground === ground) &&
    (categories === null || (row.category !== null && categories.includes(row.category)));

const sameAs = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface RestrictionArgsBase {
  readonly storage: Pick<Storage, "transact" | "persons" | "eventStore">;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly concurrencyRetries: number;
  readonly personId: string;
  readonly actor?: string | undefined;
  /**
   * The categories the app has, which `categories` must name.
   */
  readonly categories: CategoryNames;
  /**
   * Where each change is recorded before it commits, as a forgetting is.
   */
  readonly intentions: Pick<ForgetIntentions, "record">;
}

export interface RestrictProcessingArgs extends RestrictionArgsBase {
  readonly options: RestrictOptions;
}

export interface RestrictProcessingFunction {
  (args: RestrictProcessingArgs): Promise<StoredDispatch>;
}

export interface UnrestrictProcessingArgs extends RestrictionArgsBase {
  readonly options: UnrestrictOptions;
}

export interface UnrestrictProcessingFunction {
  (args: UnrestrictProcessingArgs): Promise<StoredDispatch>;
}

export interface LiftAnnouncedArgs extends Omit<RestrictionArgsBase, "categories" | "actor"> {
  readonly payload: LiftRestrictionPayload;
  /**
   * The context the lift was scheduled with: whoever announced it lifts it.
   */
  readonly context: CausationContext;
}

export interface LiftAnnouncedFunction {
  (args: LiftAnnouncedArgs): Promise<StoredDispatch>;
}

const checkGround = (ground: unknown, subject: string): RestrictionGround => {
  if (!RESTRICTION_GROUNDS.includes(ground as RestrictionGround)) {
    throw new ValidationError(`${subject} needs a ground of article 18(1)`, [
      {
        path: ["ground"],
        message: `Expected one of ${RESTRICTION_GROUNDS.map((name) => JSON.stringify(name)).join(", ")}`,
      },
    ]);
  }
  return ground as RestrictionGround;
};

// Positive: a lift announced for now would tell the person once it is done.
const noticeMs = (notice: RestrictionNotice | undefined): number | "given" => {
  if (notice === "given") return notice;
  const invalid = () =>
    new ValidationError('unrestrict needs a notice: a positive duration, or "given"', [
      {
        path: ["notice"],
        message: 'Expected a positive duration, or "given" for a person told already',
      },
    ]);
  if (notice === undefined) throw invalid();
  let ms: number;
  try {
    ms = parseDuration(notice);
  } catch {
    throw invalid();
  }
  if (!(ms > 0)) throw invalid();
  return ms;
};

const versionOf = async (transaction: StorageTransaction, personId: string): Promise<number> =>
  (
    await transaction.eventStore.load({
      aggregateType: BOUNDA_AGGREGATE,
      aggregateId: personId,
      fromVersion: Number.MAX_SAFE_INTEGER,
    })
  ).version;

interface Changed {
  readonly event: StoredEvent | null;
  readonly version: number;
}

// A change that does nothing still answers with the stream's version, as a command without
// events does, so a caller waits on nothing.
const answer = (personId: string, { event, version }: Changed): StoredDispatch => ({
  scheduled: false,
  aggregateType: BOUNDA_AGGREGATE,
  aggregateId: personId,
  version,
  eventIds: event === null ? [] : [event.id],
  eventTypes: event === null ? [] : [event.type],
  position: event?.position ?? 0,
});

const scheduleRetry = (
  transaction: StorageTransaction,
  personId: string,
  event: StoredEvent,
): Promise<void> =>
  transaction.scheduler.schedule({
    dedupeKey: retryRestrictedKey(personId),
    command: {
      type: RETRY_RESTRICTED_COMMAND,
      aggregateId: personId,
      payload: { personId },
    },
    executeAt: new Date(event.timestamp),
    context: { ...causedBy(event), depth: 0 },
  });

type Announced = Extract<
  LedgerRestriction,
  { readonly type: typeof PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT }
>;

// One entry per category announced, so a later announcement on the ground adds its own rather
// than replacing what the person was told before.
const scheduleLifts = async (
  transaction: StorageTransaction,
  event: StoredEvent,
  { payload: { personId, grounds, categories, liftsAt } }: Announced,
): Promise<void> => {
  for (const ground of grounds) {
    for (const category of categories ?? [null]) {
      const scheduled: LiftRestrictionPayload = {
        personId,
        ground,
        categories: category === null ? null : [category],
      };
      await transaction.scheduler.schedule({
        dedupeKey: liftRestrictionKey(personId, ground, category),
        command: { type: LIFT_RESTRICTION_COMMAND, aggregateId: personId, payload: scheduled },
        executeAt: new Date(liftsAt),
        context: { ...causedBy(event), depth: 0 },
      });
    }
  }
};

// Cancels the lifts announced on the ground, of it as a whole and of each category named: an
// entry of a category none of these reaches finds nothing to lift when it comes due.
const cancelLifts = async (
  transaction: StorageTransaction,
  personId: string,
  ground: RestrictionGround,
  categories: readonly (string | null)[],
): Promise<void> => {
  for (const category of new Set([null, ...categories])) {
    await transaction.scheduler.cancel(liftRestrictionKey(personId, ground, category));
  }
};

const categoriesOn = (
  rows: readonly StoredRestriction[],
  ground: RestrictionGround,
): readonly (string | null)[] =>
  rows.filter((row) => row.ground === ground).map((row) => row.category);

// A lift cancels the lifts announced of what it lifted, and has the dead letters the restriction
// caused retried.
const lifted = async (
  transaction: StorageTransaction,
  event: StoredEvent,
  {
    personId,
    grounds,
  }: { readonly personId: string; readonly grounds: readonly RestrictionGround[] },
  before: readonly StoredRestriction[],
): Promise<void> => {
  const after = await transaction.persons.restrictions(personId);
  for (const ground of grounds) {
    const left = categoriesOn(after, ground);
    const gone = categoriesOn(before, ground).filter((category) => !left.includes(category));
    if (left.length === 0) await cancelLifts(transaction, personId, ground, gone);
    else {
      for (const category of gone) {
        await transaction.scheduler.cancel(liftRestrictionKey(personId, ground, category));
      }
    }
  }
  await scheduleRetry(transaction, personId, event);
};

interface Planned {
  readonly restriction: LedgerRestriction;
  /**
   * Writes the change in the transaction, after its event.
   */
  readonly apply: (transaction: StorageTransaction, event: StoredEvent) => Promise<void>;
}

interface ChangeArgs {
  readonly storage: RestrictionArgsBase["storage"];
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly concurrencyRetries: number;
  readonly intentions: RestrictionArgsBase["intentions"];
  readonly personId: string;
  readonly context: CausationContext;
  /**
   * What the change does to the rows read, at the intention's time; `null` when it does nothing.
   */
  readonly plan: (
    rows: readonly StoredRestriction[],
    at: string,
    announced: ReadonlySet<RestrictionGround>,
  ) => Planned | null;
}

// The grounds whose lift was announced and has not come, as the person's stream tells: a
// restriction on the ground since, or a lift that left nothing of it, ends it.
const announcedGrounds = (events: readonly StoredEvent[]): ReadonlySet<RestrictionGround> => {
  const announced = new Set<RestrictionGround>();
  for (const event of events) {
    const restriction = { type: event.type, payload: event.payload } as LedgerRestriction;
    if (restriction.type === PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT) {
      for (const ground of restriction.payload.grounds) announced.add(ground);
    } else if (restriction.type === PROCESSING_RESTRICTED_EVENT) {
      announced.delete(restriction.payload.ground);
    } else if (restriction.type === PROCESSING_RESTRICTION_LIFTED_EVENT) {
      for (const ground of restriction.payload.grounds) {
        if (!restriction.payload.restrictions.some((left) => left.ground === ground)) {
          announced.delete(ground);
        }
      }
    }
  }
  return announced;
};

interface RestrictionState {
  readonly persons: Pick<Storage["persons"], "restrictions">;
  readonly eventStore: Pick<Storage["eventStore"], "load">;
}

const stateOf = async (
  { persons, eventStore }: RestrictionState,
  personId: string,
): Promise<readonly [readonly StoredRestriction[], ReadonlySet<RestrictionGround>]> => {
  const rows = await persons.restrictions(personId);
  const { events } = await eventStore.load({
    aggregateType: BOUNDA_AGGREGATE,
    aggregateId: personId,
  });
  return [rows, announcedGrounds(events)];
};

// The change is planned on the rows as they stand, written to the ledger with the id and time its
// event will have, and committed while the rows still plan the same; rows changed meanwhile plan
// it again, under a new intention, as a forgetting that finds a key given meanwhile does. An
// intention left behind is older than the change that superseded it, which `restrictAgain` tells
// by the event's time.
const change = async ({
  storage,
  ids,
  clock,
  concurrencyRetries,
  intentions,
  personId,
  context,
  plan,
}: ChangeArgs): Promise<Changed> => {
  for (;;) {
    const id = ids.next();
    const at = clock.now().toISOString();
    const [rows, announced] = await stateOf(storage, personId);
    const planned = plan(rows, at, announced);
    if (planned !== null) {
      await intentions.record({
        personId,
        categories: null,
        eventId: id,
        forgottenAt: at,
        reason: "requested",
        restriction: planned.restriction,
      });
    }
    const changed = await transactRetrying({
      storage,
      concurrencyRetries,
      work: async (transaction): Promise<Changed | null> => {
        const [held, pending] = await stateOf(transaction, personId);
        const now = plan(held, at, pending);
        if (now === null && planned === null) {
          return { event: null, version: await versionOf(transaction, personId) };
        }
        if (now === null || planned === null || !sameAs(now.restriction, planned.restriction)) {
          return null;
        }
        const event = await appendSystemEvent({
          eventStore: transaction.eventStore,
          ids,
          clock,
          aggregateType: BOUNDA_AGGREGATE,
          aggregateId: personId,
          type: planned.restriction.type,
          payload: planned.restriction.payload,
          person: personId,
          context,
          identity: { id, timestamp: at },
        });
        await planned.apply(transaction, event);
        return { event, version: event.version };
      },
    });
    if (changed !== null) return changed;
  }
};

/**
 * Restricts the processing of the person's data on a ground, of some categories or of the person
 * as a whole: records it and appends `ProcessingRestricted` to their stream, in one transaction,
 * and cancels a lift announced on that ground, written first to the forget ledger when there is
 * one. A restriction that adds nothing appends nothing.
 */
export const restrictProcessing: RestrictProcessingFunction = async ({
  storage,
  ids,
  clock,
  logger,
  concurrencyRetries,
  personId,
  actor,
  categories: known,
  intentions,
  options,
}) => {
  checkPersonId(personId, "restrict");
  const ground = checkGround(options?.ground, "restrict");
  const categories =
    options?.categories === undefined
      ? null
      : checkCategoryNames({ categories: known, asked: options.categories, operation: "restrict" });
  const changed = await change({
    storage,
    ids,
    clock,
    concurrencyRetries,
    intentions,
    personId,
    context: startedBy(ids.next(), actor),
    // A restriction that adds nothing is still appended while a lift of its ground is announced,
    // since it is what calls that lift off.
    plan: (rows, at, announced) => {
      const after =
        restricted(rows, ground, categories, at) ?? (announced.has(ground) ? rows : null);
      if (after === null) return null;
      return {
        restriction: {
          type: PROCESSING_RESTRICTED_EVENT,
          payload: {
            personId,
            ground,
            categories: categories as readonly PersonalCategoryName[] | null,
            restrictions: processingRestrictionsOf(after),
          },
        },
        apply: async (transaction) => {
          await transaction.persons.restrict(personId, {
            ground,
            categories,
            since: new Date(at),
          });
          await cancelLifts(transaction, personId, ground, [
            ...categoriesOn(rows, ground),
            ...(categories ?? []),
          ]);
        },
      };
    },
  });
  logger.info("processing restricted", {
    personId,
    ground,
    changed: changed.event !== null,
    ...actedBy(actor),
  });
  return answer(personId, changed);
};

// The lift of what matches, at once.
const liftPlan =
  (personId: string, ground: RestrictionGround | undefined, categories: readonly string[] | null) =>
  (rows: readonly StoredRestriction[]): Planned | null => {
    const match = matches(ground, categories);
    const lifting = rows.filter(match);
    if (lifting.length === 0) return null;
    const payload = {
      personId,
      grounds: [...new Set(lifting.map((row) => row.ground))].sort(),
      categories: categories as readonly PersonalCategoryName[] | null,
      restrictions: processingRestrictionsOf(rows.filter((row) => !match(row))),
    };
    return {
      restriction: { type: PROCESSING_RESTRICTION_LIFTED_EVENT, payload },
      apply: async (transaction, event) => {
        await transaction.persons.unrestrict(personId, {
          ...(ground === undefined ? {} : { ground }),
          categories,
        });
        await lifted(transaction, event, payload, rows);
      },
    };
  };

/**
 * Lifts the person's restrictions that match: at once with `notice: "given"`, appending
 * `ProcessingRestrictionLifted` and scheduling the retry of the dead letters they caused; with a
 * duration, appending `ProcessingRestrictionLiftAnnounced` and scheduling, per ground, the lift
 * that long after. Rejects with `ValidationError` categories of a restriction of the person as a
 * whole. Nothing to lift appends nothing.
 */
export const unrestrictProcessing: UnrestrictProcessingFunction = async ({
  storage,
  ids,
  clock,
  logger,
  concurrencyRetries,
  personId,
  actor,
  categories: known,
  intentions,
  options,
}) => {
  checkPersonId(personId, "unrestrict");
  const notice = noticeMs(options?.notice);
  const ground =
    options?.ground === undefined ? undefined : checkGround(options.ground, "unrestrict");
  const categories =
    options?.categories === undefined
      ? null
      : checkCategoryNames({
          categories: known,
          asked: options.categories,
          operation: "unrestrict",
        });
  const lift = liftPlan(personId, ground, categories);
  const changed = await change({
    storage,
    ids,
    clock,
    concurrencyRetries,
    intentions,
    personId,
    context: startedBy(ids.next(), actor),
    plan: (rows, at) => {
      const whole = rows.find(
        (row) => (ground === undefined || row.ground === ground) && row.category === null,
      );
      if (categories !== null && whole !== undefined) {
        throw new ValidationError(
          `unrestrict names categories of a person restricted as a whole on "${whole.ground}"; lift that restriction as a whole`,
          [{ path: ["categories"], message: "Expected no categories for this ground" }],
        );
      }
      if (notice === "given") return lift(rows);
      const grounds = [
        ...new Set(rows.filter(matches(ground, categories)).map((row) => row.ground)),
      ].sort();
      if (grounds.length === 0) return null;
      const restriction: Announced = {
        type: PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT,
        payload: {
          personId,
          grounds,
          categories: categories as readonly PersonalCategoryName[] | null,
          liftsAt: new Date(Date.parse(at) + notice).toISOString(),
        },
      };
      return {
        restriction,
        apply: (transaction, event) => scheduleLifts(transaction, event, restriction),
      };
    },
  });
  logger.info(
    notice === "given" ? "processing restriction lifted" : "processing restriction lift announced",
    { personId, changed: changed.event !== null, ...actedBy(actor) },
  );
  return answer(personId, changed);
};

/**
 * Lifts what an announcement scheduled, once its notice has run: what still matches then, which a
 * `restrict` on the ground since would have cancelled.
 */
export const liftAnnounced: LiftAnnouncedFunction = async ({
  storage,
  ids,
  clock,
  logger,
  concurrencyRetries,
  intentions,
  personId,
  payload,
  context,
}) => {
  const changed = await change({
    storage,
    ids,
    clock,
    concurrencyRetries,
    intentions,
    personId,
    context,
    plan: liftPlan(personId, payload.ground, payload.categories),
  });
  logger.info("processing restriction lifted", {
    personId,
    ground: payload.ground,
    changed: changed.event !== null,
    ...actedBy(context.actor),
  });
  return answer(personId, changed);
};

export interface RestrictAgainArgs {
  readonly storage: Pick<Storage, "transact">;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly concurrencyRetries: number;
  readonly entry: ForgetLedgerEntry & { readonly restriction: LedgerRestriction };
}

export interface RestrictAgainFunction {
  (args: RestrictAgainArgs): Promise<StoredEvent | null>;
}

const RESTRICTION_TYPES: ReadonlySet<string> = new Set([
  PROCESSING_RESTRICTED_EVENT,
  PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT,
  PROCESSING_RESTRICTION_LIFTED_EVENT,
]);

// In the ledger's order: by time, then by id.
const isLater = (event: StoredEvent, entry: ForgetLedgerEntry): boolean =>
  event.timestamp > entry.forgottenAt ||
  (event.timestamp === entry.forgottenAt && event.id > entry.eventId);

/**
 * Commits again a change of restrictions the ledger holds and the store does not, with its id and
 * time, and resolves to the event it appended: due while no later change of the person's
 * restrictions is in the store, and, for a restriction or a lift, while the rows the store holds
 * are not already what it left. An intention whose commit never happened is committed the same
 * way, since it is what was asked. Resolves `null` for one not due.
 */
export const restrictAgain: RestrictAgainFunction = ({
  storage,
  ids,
  clock,
  concurrencyRetries,
  entry,
}) => {
  const { personId, eventId, forgottenAt, restriction } = entry;
  return transactRetrying({
    storage,
    concurrencyRetries,
    work: async (transaction) => {
      const { events } = await transaction.eventStore.load({
        aggregateType: BOUNDA_AGGREGATE,
        aggregateId: personId,
      });
      if (
        events.some(
          (event) =>
            RESTRICTION_TYPES.has(event.type) && (event.id === eventId || isLater(event, entry)),
        )
      ) {
        return null;
      }
      if (restriction.type !== PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT) {
        const held = processingRestrictionsOf(await transaction.persons.restrictions(personId));
        if (sameAs(held, restriction.payload.restrictions)) return null;
      }
      const event = await appendSystemEvent({
        eventStore: transaction.eventStore,
        ids,
        clock,
        aggregateType: BOUNDA_AGGREGATE,
        aggregateId: personId,
        type: restriction.type,
        payload: restriction.payload,
        person: personId,
        context: startedBy(ids.next(), undefined),
        identity: { id: eventId, timestamp: forgottenAt },
      });
      if (restriction.type === PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT) {
        await scheduleLifts(transaction, event, restriction);
        return event;
      }
      const before = await transaction.persons.restrictions(personId);
      await transaction.persons.unrestrict(personId, { categories: null });
      for (const { ground, categories, since } of restriction.payload.restrictions) {
        await transaction.persons.restrict(personId, {
          ground,
          categories,
          since: new Date(since),
        });
      }
      if (restriction.type === PROCESSING_RESTRICTED_EVENT) {
        const { ground, categories } = restriction.payload;
        await cancelLifts(transaction, personId, ground, [
          ...categoriesOn(before, ground),
          ...(categories ?? []),
        ]);
      } else {
        await lifted(transaction, event, restriction.payload, before);
      }
      return event;
    },
  });
};
