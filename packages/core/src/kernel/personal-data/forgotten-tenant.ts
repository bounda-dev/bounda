import type { ReadModelStorage, Storage, StorageTransaction } from "../../adapter/adapter.ts";
import type { TenantForgetting } from "../../adapter/storage/tenant-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { TenantForgottenError } from "../../contracts/errors.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { CausationContext } from "../../contracts/metadata.ts";
import {
  BOUNDA_AGGREGATE,
  TENANT_FORGOTTEN_EVENT,
  type TenantForgottenPayload,
} from "../../modules/bounda-events.ts";
import type { PersonalCategoryName } from "../../modules/personal-data.ts";
import type { NotifiedRecipient } from "../../modules/recipient.ts";
import type { Subscriber } from "../dispatch/dispatcher.ts";
import { projectionSubscriberName } from "../projection/runner.ts";
import { RECIPIENTS_SUBSCRIBER, type RecipientDelivery } from "../recipients/notices.ts";
import { appendSystemEvent } from "../system-events.ts";
import { transactRetrying } from "./transact.ts";

/**
 * How long an instance goes at most between two reads of whether its tenant was forgotten
 * elsewhere: past it, the next call reads the database's binding again.
 */
export const TENANT_CHECK_INTERVAL_MS = 10_000;

/**
 * What `forgetTenant` takes.
 */
export interface ForgetTenantOptions {
  /**
   * Destroys the keys of categories whose basis is `legal-obligation` with the rest, kept past a
   * forgetting or in force: the law that keeps them is then the controller's to answer for, as
   * when the data was handed back first. Without it, a tenant whose persons hold such a key is
   * refused with `ValidationError` and nothing is forgotten.
   */
  readonly despiteLegalObligations?: boolean;
}

/**
 * A tenant forgotten: when, and the `TenantForgotten` event that records it.
 */
export interface TenantForgottenResult {
  readonly tenant: string;
  readonly forgottenAt: string;
  readonly eventId: string;
}

export interface AddressedTenantFunction {
  (transaction: Pick<StorageTransaction, "recipients">): Promise<readonly NotifiedRecipient[]>;
}

/**
 * Every port a disclosure of any person was recorded to, with every category it received, and
 * every port declared after data already existed, with what its declaration names, presumed.
 */
export const addressedTenant: AddressedTenantFunction = async (transaction) => {
  const received = await transaction.recipients.received();
  const presumed = new Map(
    (await transaction.recipients.declared())
      .filter(({ presumedThrough }) => presumedThrough > 0)
      .map(({ port, categories }) => [port, categories]),
  );
  return [...new Set([...received.keys(), ...presumed.keys()])].sort().map((port) => {
    const known = received.get(port) ?? [];
    return {
      port,
      categories: [
        ...new Set([...known, ...(presumed.get(port) ?? [])]),
      ].sort() as PersonalCategoryName[],
      retained: [],
      // Presumed to hold data no disclosure recorded: it may hold others' than `persons()` lists.
      presumed: presumed.has(port),
    };
  });
};

/**
 * A read model whose rows a tenant's forgetting removes: every one but those whose view says they
 * keep nothing derived from personal data.
 */
export interface ForgottenReadModel {
  readonly name: string;
  readonly storage: Pick<ReadModelStorage, "transact">;
}

export interface SettleTenantForgettingArgs {
  readonly storage: Pick<
    Storage,
    | "transact"
    | "tenancy"
    | "personalKeys"
    | "indexKeys"
    | "snapshotStore"
    | "idempotencyStore"
    | "subscriberFailures"
  >;
  readonly readModels: readonly ForgottenReadModel[];
  readonly tenant: string;
  readonly forgetting: TenantForgetting;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly concurrencyRetries: number;
  readonly context: CausationContext;
}

export interface SettleTenantForgettingFunction {
  (args: SettleTenantForgettingArgs): Promise<void>;
}

/**
 * What a tenant's forgetting leaves in its database once its key is destroyed: the binding marked,
 * `TenantForgotten` appended unless the store holds it, every person's key and the database's key
 * removed, every snapshot, remembered answer and subscriber failure with them, and the rows of the
 * read models that may hold personal data deleted, those kept in the clear among them: what
 * another instance would still open with a key it keeps in memory is gone. Every step can run
 * again: a start that finds the tenant forgotten runs it all, for a forgetting cut short or a
 * database restored from a copy.
 */
export const settleTenantForgetting: SettleTenantForgettingFunction = async ({
  storage,
  readModels,
  tenant,
  forgetting,
  ids,
  clock,
  concurrencyRetries,
  context,
}) => {
  await storage.tenancy.forget(forgetting.at);
  await transactRetrying({
    storage,
    concurrencyRetries,
    work: async (transaction) => {
      const recorded = await transaction.eventStore.readOne({
        aggregateType: BOUNDA_AGGREGATE,
        aggregateId: tenant,
        eventId: forgetting.eventId,
      });
      if (recorded !== null) return;
      const recipients = await addressedTenant(transaction);
      const payload: TenantForgottenPayload = {
        tenant,
        categories: (await transaction.personalKeys.categories()) as PersonalCategoryName[],
        ...(recipients.length === 0 ? {} : { recipients }),
      };
      await appendSystemEvent({
        eventStore: transaction.eventStore,
        ids,
        clock,
        aggregateType: BOUNDA_AGGREGATE,
        aggregateId: tenant,
        type: TENANT_FORGOTTEN_EVENT,
        payload,
        context,
        identity: { id: forgetting.eventId, timestamp: forgetting.at },
      });
    },
  });
  await storage.personalKeys.clear();
  await storage.indexKeys.clear();
  await storage.snapshotStore.clear();
  await storage.idempotencyStore.clear();
  // No subscriber of the tenant runs again to resolve its last failure, so no retention would end it.
  await storage.subscriberFailures.clear();
  for (const { name, storage: readModel } of readModels) {
    await readModel.transact({
      subscriber: projectionSubscriberName(name),
      wait: true,
      work: ({ table }) => table.delete({}),
    });
  }
};

export interface CreateTenantNoticeSubscriberArgs {
  readonly delivery: RecipientDelivery;
}

export interface CreateTenantNoticeSubscriberFunction {
  (args: CreateTenantNoticeSubscriberArgs): Subscriber;
}

/**
 * The recipients' subscriber of an app whose tenant was forgotten: it tells each recipient
 * `TenantForgotten` names, and passes every other event by, since the tenant's forgetting tells
 * them of everything a notice still pending would have.
 */
export const createTenantNoticeSubscriber: CreateTenantNoticeSubscriberFunction = ({
  delivery,
}) => ({
  name: RECIPIENTS_SUBSCRIBER,
  kind: "policy",
  process: async (events) => {
    for (const [index, event] of events.entries()) {
      if (event.aggregateType !== BOUNDA_AGGREGATE || event.type !== TENANT_FORGOTTEN_EVENT) {
        continue;
      }
      let held = false;
      for (const told of (event.payload as TenantForgottenPayload).recipients ?? []) {
        if ((await delivery.deliver(told.port, event, told)) === "hold") held = true;
      }
      if (held) return index;
    }
    return events.length;
  },
});

export interface RejectingFunction {
  (forgetting: () => TenantForgottenError): unknown;
}

/**
 * A facade every call of which, at any depth, rejects with the tenant's forgetting: what an app
 * whose tenant was forgotten has for commands, queries and every other read.
 */
export const rejecting: RejectingFunction = (forgetting) => {
  const reject = async (): Promise<never> => {
    throw forgetting();
  };
  const facade: unknown = new Proxy(reject, {
    get: (_, property) => (property === "then" ? undefined : facade),
    apply: () => reject(),
  });
  return facade;
};
