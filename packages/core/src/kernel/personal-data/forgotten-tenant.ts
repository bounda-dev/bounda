import type { ReadModelStorage, Storage, StorageTransaction } from "../../adapter/adapter.ts";
import type {
  ForgetLedger,
  ForgetLedgerEntry,
  ForgetLedgerPosition,
} from "../../adapter/storage/forget-ledger.ts";
import type { RecipientPort } from "../../adapter/storage/recipient-store.ts";
import type { TenantForgetting } from "../../adapter/storage/tenant-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { TenantForgottenError } from "../../contracts/errors.ts";
import type { IdGenerator } from "../../contracts/ids.ts";
import type { Logger } from "../../contracts/logger.ts";
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
import { discloseAgain } from "../recipients/again.ts";
import { RECIPIENTS_SUBSCRIBER, type RecipientDelivery } from "../recipients/notices.ts";
import { appendSystemEvent } from "../system-events.ts";
import {
  FORGET_LEDGER_CURSOR,
  FORGET_LEDGER_PAGE,
  FORGET_LEDGER_REREAD_MS,
} from "./reconciliation.ts";
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
  (
    transaction: Pick<StorageTransaction, "recipients">,
    presumedAll: readonly RecipientPort[],
  ): Promise<readonly NotifiedRecipient[]>;
}

/**
 * Every port a disclosure of any person was recorded to, with every category it received, and
 * every port declared after data already existed, with what its declaration names, presumed, as
 * every port of `presumedAll` is, for a database that may have lost disclosures no one can tell.
 */
export const addressedTenant: AddressedTenantFunction = async (transaction, presumedAll) => {
  const received = await transaction.recipients.received();
  const presumed = new Map(
    [
      ...(await transaction.recipients.declared()).filter(
        ({ presumedThrough }) => presumedThrough > 0,
      ),
      ...presumedAll,
    ].map(({ port, categories }) => [port, categories]),
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

interface DiscloseLostAgainArgs {
  readonly storage: Pick<Storage, "transact" | "checkpointStore">;
  readonly ledger: Pick<ForgetLedger, "read">;
  readonly concurrencyRetries: number;
}

// The disclosures past the database's cursor, as a reconciliation reads them: what a copy of the
// database lost of those made after it was taken. Resolves why the ledger could not be read; a
// database that fails rejects, as any settling does.
const discloseLostAgain = async ({
  storage,
  ledger,
  concurrencyRetries,
}: DiscloseLostAgainArgs): Promise<{ readonly failed: unknown } | null> => {
  const cursor = await storage.checkpointStore.get(FORGET_LEDGER_CURSOR);
  let after: ForgetLedgerPosition | undefined =
    cursor === 0
      ? undefined
      : { forgottenAt: new Date(cursor - FORGET_LEDGER_REREAD_MS).toISOString(), eventId: "" };
  for (;;) {
    let page: readonly ForgetLedgerEntry[];
    try {
      page = await ledger.read({
        ...(after === undefined ? {} : { after }),
        limit: FORGET_LEDGER_PAGE,
      });
    } catch (failed) {
      return { failed };
    }
    for (const entry of page) {
      const { disclosure } = entry;
      if (disclosure !== undefined) {
        await discloseAgain({ storage, concurrencyRetries, entry: { ...entry, disclosure } });
      }
    }
    if (page.length < FORGET_LEDGER_PAGE) return null;
    after = page.at(-1);
  }
};

export interface SettleTenantForgettingArgs {
  readonly storage: Pick<
    Storage,
    | "transact"
    | "eventStore"
    | "checkpointStore"
    | "tenancy"
    | "personalKeys"
    | "indexKeys"
    | "snapshotStore"
    | "idempotencyStore"
    | "subscriberFailures"
    | "deadLetterStore"
  >;
  readonly readModels: readonly ForgottenReadModel[];
  readonly tenant: string;
  readonly forgetting: TenantForgetting;
  /**
   * The forget ledger, `null` without one: the disclosures it holds that the database lost are
   * recorded again before the recipients to tell are read.
   */
  readonly ledger: Pick<ForgetLedger, "read"> | null;
  /**
   * Whether the database may be a copy taken before the forgetting, as for any settling but the
   * forgetting's own: without a ledger to tell what the copy lost, every port of `ports` is
   * presumed to hold the tenant's data.
   */
  readonly mayBeCopy: boolean;
  readonly ports: readonly RecipientPort[];
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly concurrencyRetries: number;
  readonly context: CausationContext;
}

export interface SettleTenantForgettingFunction {
  (args: SettleTenantForgettingArgs): Promise<void>;
}

/**
 * What a tenant's forgetting leaves in its database once its key is destroyed: the binding marked,
 * `TenantForgotten` appended unless the store holds it, every person's key and the database's key
 * removed, every snapshot, remembered answer, subscriber failure and dead letter with them but the
 * letters of the notices of the forgetting itself, and the rows of the read models that may hold
 * personal data deleted, those kept in the clear among them: what another instance would still
 * open with a key it keeps in memory is gone. Every step can run
 * again: a start that finds the tenant forgotten runs it all, for a forgetting cut short or a
 * database restored from a copy.
 */
export const settleTenantForgetting: SettleTenantForgettingFunction = async ({
  storage,
  readModels,
  tenant,
  forgetting,
  ledger,
  mayBeCopy,
  ports,
  ids,
  clock,
  logger,
  concurrencyRetries,
  context,
}) => {
  await storage.tenancy.forget(forgetting.at);
  const unrecorded =
    (await storage.eventStore.readOne({
      aggregateType: BOUNDA_AGGREGATE,
      aggregateId: tenant,
      eventId: forgetting.eventId,
    })) === null;
  // A recipient of a disclosure the database lost would hear nothing of the forgetting.
  const lost =
    unrecorded && ledger !== null
      ? await discloseLostAgain({ storage, ledger, concurrencyRetries })
      : null;
  if (lost !== null) {
    logger.error(
      "the forget ledger could not be read for the disclosures the database lost: every declared recipient is presumed to hold the tenant's data",
      { tenant, error: lost.failed },
    );
  }
  const presumeAll = lost !== null || (unrecorded && ledger === null && mayBeCopy);
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
      const recipients = await addressedTenant(transaction, presumeAll ? ports : []);
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
  // Nor does any letter retention, nor a retry of the work the tenant gave up on; the forgotten app
  // tells the recipients of the forgetting alone, through letters of its own.
  await storage.deadLetterStore.clear(forgetting.eventId);
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
