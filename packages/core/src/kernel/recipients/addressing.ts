import type { StorageTransaction } from "../../adapter/adapter.ts";
import type { DeclaredRecipient } from "../../adapter/storage/recipient-store.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import {
  BOUNDA_AGGREGATE,
  PERSONAL_DATA_FORGOTTEN_EVENT,
  PERSONAL_DATA_REDACTED_EVENT,
  type PersonalDataForgottenPayload,
  type PersonalDataRedactedPayload,
  PROCESSING_RESTRICTED_EVENT,
  PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT,
  PROCESSING_RESTRICTION_LIFTED_EVENT,
  type ProcessingRestrictedPayload,
  type ProcessingRestrictionLiftAnnouncedPayload,
  type ProcessingRestrictionLiftedPayload,
} from "../../modules/bounda-events.ts";
import type { PersonalCategoryName } from "../../modules/personal-data.ts";
import type { NotifiedRecipient } from "../../modules/recipient.ts";

/**
 * One of the runtime's events recipients are told of, with its payload as it would be appended.
 */
export type RecipientEvent =
  | {
      readonly type: typeof PERSONAL_DATA_FORGOTTEN_EVENT;
      readonly payload: PersonalDataForgottenPayload;
    }
  | {
      readonly type: typeof PROCESSING_RESTRICTED_EVENT;
      readonly payload: ProcessingRestrictedPayload;
    }
  | {
      readonly type: typeof PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT;
      readonly payload: ProcessingRestrictionLiftAnnouncedPayload;
    }
  | {
      readonly type: typeof PROCESSING_RESTRICTION_LIFTED_EVENT;
      readonly payload: ProcessingRestrictionLiftedPayload;
    }
  | {
      readonly type: typeof PERSONAL_DATA_REDACTED_EVENT;
      readonly payload: PersonalDataRedactedPayload;
    };

/**
 * The event types recipients are told of.
 */
export const RECIPIENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  PERSONAL_DATA_FORGOTTEN_EVENT,
  PROCESSING_RESTRICTED_EVENT,
  PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT,
  PROCESSING_RESTRICTION_LIFTED_EVENT,
  PERSONAL_DATA_REDACTED_EVENT,
]);

export interface Touched {
  // `null` for every category.
  readonly categories: readonly string[] | null;
  readonly retained: readonly string[];
}

export interface TouchedByFunction {
  (event: RecipientEvent): Touched;
}

/**
 * The categories an event of the runtime's touches: those it forgets, restricts, lifts or redacts,
 * and those a forgetting kept under an erasure exemption instead.
 */
export const touchedBy: TouchedByFunction = (event) => {
  switch (event.type) {
    case PERSONAL_DATA_FORGOTTEN_EVENT:
      return {
        categories: [...event.payload.categories, ...event.payload.expired],
        retained: event.payload.retained,
      };
    default:
      return { categories: event.payload.categories, retained: [] };
  }
};

export const within = (
  received: ReadonlySet<string>,
  touched: readonly string[] | null,
): string[] =>
  [...received].filter((category) => touched === null || touched.includes(category)).sort();

export interface PresumedOfFunction {
  (
    transaction: Pick<StorageTransaction, "recipients" | "eventStore">,
    personId: string,
  ): Promise<Map<string, Set<string>>>;
}

/**
 * The categories each port may hold of the person unrecorded: those its declaration names, for a
 * port declared, or presumed again after a restore, once the person's data already existed, but
 * those a forgetting told it to erase since.
 */
export const presumedOf: PresumedOfFunction = async (transaction, personId) => {
  const presumed = new Map<string, Set<string>>();
  const declared = (await transaction.recipients.declared()).filter(
    ({ presumedThrough }) => presumedThrough > 0,
  );
  if (declared.length === 0) return presumed;
  const [first] = await transaction.eventStore.readByPerson({
    person: personId,
    afterPosition: 0,
    limit: 1,
  });
  if (first === undefined) return presumed;
  for (const { port, categories, presumedThrough } of declared) {
    if (first.position <= presumedThrough) presumed.set(port, new Set(categories));
  }
  if (presumed.size > 0) {
    const { events } = await transaction.eventStore.load({
      aggregateType: BOUNDA_AGGREGATE,
      aggregateId: personId,
    });
    forgetTold(presumed, events);
  }
  return presumed;
};

export interface PresumedOfManyFunction {
  (
    transaction: Pick<StorageTransaction, "eventStore">,
    persons: readonly string[],
    recipients: readonly DeclaredRecipient[],
  ): Promise<ReadonlyMap<string, Map<string, Set<string>>>>;
}

// `presumedOf` of each of `persons`, in two reads of the event store however many they are, with
// the declared recipients read already.
export const presumedOfMany: PresumedOfManyFunction = async (transaction, persons, recipients) => {
  const presumed = new Map<string, Map<string, Set<string>>>();
  for (const person of persons) presumed.set(person, new Map());
  const declared = recipients.filter(({ presumedThrough }) => presumedThrough > 0);
  if (declared.length === 0) return presumed;
  // The persons some recipient is presumed to hold data of, with what.
  const held = new Map<string, Map<string, Set<string>>>();
  for (const [person, position] of await transaction.eventStore.firstPositions(persons)) {
    const ports = presumed.get(person) as Map<string, Set<string>>;
    for (const { port, categories, presumedThrough } of declared) {
      if (position <= presumedThrough) ports.set(port, new Set(categories));
    }
    if (ports.size > 0) held.set(person, ports);
  }
  if (held.size === 0) return presumed;
  const streams = await transaction.eventStore.loadMany({
    aggregateType: BOUNDA_AGGREGATE,
    aggregateIds: [...held.keys()],
  });
  for (const [person, events] of streams) {
    forgetTold(held.get(person) as Map<string, Set<string>>, events);
  }
  return presumed;
};

// What a recipient was told to forget of the person it holds no longer: it is presumed to hold
// only what came before.
const forgetTold = (presumed: Map<string, Set<string>>, events: readonly StoredEvent[]): void => {
  for (const told of events) {
    if (told.type !== PERSONAL_DATA_FORGOTTEN_EVENT) continue;
    const { recipients = [] } = told.payload as PersonalDataForgottenPayload;
    for (const { port, categories } of recipients) {
      for (const category of categories) presumed.get(port)?.delete(category);
    }
  }
};

export interface AddressedFunction {
  <Event extends RecipientEvent>(
    transaction: Pick<StorageTransaction, "recipients" | "eventStore">,
    event: Event,
  ): Promise<Event["payload"]>;
}

/**
 * The payload with the recipients to tell of the event, none when there is no one to tell: every port a disclosure of the person was
 * recorded to, and every port declared after the person's data already existed, which may have
 * received it unrecorded, each with the categories it received that the event touches. Read in
 * the transaction that appends the event, so a disclosure recorded meanwhile is either among them
 * or refused for coming after it. A forgetting removes the disclosures of what it forgot: the
 * event keeps who is told.
 */
export const addressed: AddressedFunction = async (transaction, event) => {
  const { personId } = event.payload;
  const recorded = new Map<string, Set<string>>();
  for (const { port, category } of await transaction.recipients.disclosures(personId)) {
    recorded.set(port, (recorded.get(port) ?? new Set()).add(category));
  }
  const presumed = await presumedOf(transaction, personId);
  const touched = touchedBy(event);
  const recipients: NotifiedRecipient[] = [];
  for (const port of [...new Set([...recorded.keys(), ...presumed.keys()])].sort()) {
    const known = recorded.get(port) ?? new Set<string>();
    const received = new Set([...known, ...(presumed.get(port) ?? [])]);
    const categories = within(received, touched.categories);
    const retained = within(received, touched.retained);
    if (categories.length === 0 && retained.length === 0) continue;
    recipients.push({
      port,
      categories: categories as PersonalCategoryName[],
      retained: retained as PersonalCategoryName[],
      presumed: ![...categories, ...retained].some((category) => known.has(category)),
    });
  }
  if (event.type === PERSONAL_DATA_FORGOTTEN_EVENT) {
    await transaction.recipients.forget(personId, [
      ...event.payload.categories,
      ...event.payload.expired,
    ]);
  }
  return recipients.length === 0 ? event.payload : { ...event.payload, recipients };
};
