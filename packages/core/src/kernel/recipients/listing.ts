import type { StorageTransaction } from "../../adapter/adapter.ts";
import type {
  HeldPersonalKey,
  PersonalKeyStore,
} from "../../adapter/storage/personal-key-store.ts";
import type { StoredDisclosure } from "../../adapter/storage/recipient-store.ts";
import type { PersonalCategoryName } from "../../modules/personal-data.ts";
import type {
  CountryCode,
  PersonRecipient,
  RecipientKind,
  TransferSafeguard,
} from "../../modules/recipient.ts";
import type { PersonalCategories } from "../personal-data/categories.ts";
import type { RecipientStatus } from "../status.ts";
import { presumedAmong, presumedOf } from "./addressing.ts";
import type { RecipientsRuntime } from "./build.ts";

export interface RecipientsOfArgs {
  readonly storage: Pick<StorageTransaction, "recipients" | "eventStore"> & {
    readonly personalKeys: Pick<PersonalKeyStore, "list">;
  };
  readonly recipients: RecipientsRuntime;
  readonly categories: PersonalCategories;
  readonly personId: string;
}

export interface RecipientsOfFunction {
  (args: RecipientsOfArgs): Promise<readonly PersonRecipient[]>;
}

interface Identity {
  readonly port: string;
  readonly name: string;
  readonly kind: RecipientKind;
  readonly country: CountryCode;
  readonly safeguard: TransferSafeguard | null;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const STATUS_ORDER: Readonly<Record<PersonRecipient["status"], number>> = {
  disclosed: 0,
  presumed: 1,
  declared: 2,
};

/**
 * The recipients of a person's data, as article 15(1)(c) and the last sentence of article 19 ask:
 * each one recorded as disclosed data of theirs, under the identity it had then; each one declared
 * after their data already existed, presumed to hold it; and each one the app declares for a
 * category the person has data of and that received none yet, which it may receive. Every one
 * with the categories concerned and their basis, its country and the safeguard of a transfer out
 * of the European Economic Area.
 */
export const recipientsOf: RecipientsOfFunction = async ({
  storage,
  recipients,
  categories,
  personId,
}) =>
  recipientsFrom({
    recipients,
    categories,
    disclosures: await storage.recipients.disclosures(personId),
    // A category the person holds no key of now was never theirs, or was forgotten and its
    // recipients told.
    held: new Set((await storage.personalKeys.list(personId)).map(({ category }) => category)),
    presumed: await presumedOf(storage, personId),
  });

export interface RecipientsOfPageArgs {
  readonly storage: Pick<StorageTransaction, "recipients" | "eventStore">;
  readonly recipients: RecipientsRuntime;
  readonly categories: PersonalCategories;
  readonly persons: readonly string[];
  /**
   * The keys of `persons`, by person, as `PersonalKeyStore.listMany` reads them.
   */
  readonly keys: ReadonlyMap<string, readonly Pick<HeldPersonalKey, "category">[]>;
}

export interface RecipientsOfPageFunction {
  (args: RecipientsOfPageArgs): Promise<ReadonlyMap<string, readonly PersonRecipient[]>>;
}

/**
 * `recipientsOf` of each of a page of persons, their disclosures and the declared recipients each
 * read once for the page.
 */
export const recipientsOfPage: RecipientsOfPageFunction = async ({
  storage,
  recipients,
  categories,
  persons,
  keys,
}) => {
  const [disclosures, declared] = await Promise.all([
    storage.recipients.disclosuresOfMany(persons),
    storage.recipients.declared(),
  ]);
  const listed = new Map<string, readonly PersonRecipient[]>();
  for (const personId of persons) {
    listed.set(
      personId,
      recipientsFrom({
        recipients,
        categories,
        disclosures: disclosures.get(personId) ?? [],
        held: new Set((keys.get(personId) ?? []).map(({ category }) => category)),
        presumed: await presumedAmong(storage, personId, declared),
      }),
    );
  }
  return listed;
};

interface RecipientsFromArgs {
  readonly recipients: RecipientsRuntime;
  readonly categories: PersonalCategories;
  readonly disclosures: readonly StoredDisclosure[];
  // The categories the person holds a key of.
  readonly held: ReadonlySet<string>;
  readonly presumed: ReadonlyMap<string, ReadonlySet<string>>;
}

const recipientsFrom = ({
  recipients,
  categories,
  disclosures,
  held,
  presumed,
}: RecipientsFromArgs): readonly PersonRecipient[] => {
  const listed: PersonRecipient[] = [];
  const entry = (
    identity: Identity,
    status: PersonRecipient["status"],
    names: Iterable<string>,
    times: { readonly first: string | null; readonly last: string | null },
  ): PersonRecipient => ({
    port: identity.port,
    name: identity.name,
    kind: identity.kind,
    country: identity.country,
    transfer: identity.safeguard === null ? null : { safeguard: identity.safeguard },
    status,
    categories: [...new Set(names)].sort().map((name) => ({
      name: name as PersonalCategoryName,
      basis: categories.of(name)?.basis ?? null,
    })),
    firstDisclosedAt: times.first,
    lastDisclosedAt: times.last,
    declared: recipients.byPort[identity.port] !== undefined,
  });
  const covered = new Map<string, Set<string>>();
  const cover = (port: string, names: Iterable<string>): void => {
    const held = covered.get(port) ?? new Set<string>();
    for (const name of names) held.add(name);
    covered.set(port, held);
  };
  const disclosed = new Map<
    string,
    { identity: Identity; names: Set<string>; first: string; last: string }
  >();
  for (const row of disclosures) {
    const port = recipients.byPort[row.port]?.port ?? row.port;
    const key = JSON.stringify([port, row.recipient, row.kind, row.country, row.safeguard]);
    const held = disclosed.get(key);
    if (held === undefined) {
      disclosed.set(key, {
        identity: {
          port,
          name: row.recipient,
          kind: row.kind as RecipientKind,
          country: row.country as CountryCode,
          safeguard: row.safeguard as TransferSafeguard | null,
        },
        names: new Set([row.category]),
        first: row.firstAt,
        last: row.lastAt,
      });
    } else {
      held.names.add(row.category);
      if (row.firstAt < held.first) held.first = row.firstAt;
      if (row.lastAt > held.last) held.last = row.lastAt;
    }
    cover(port, [row.category]);
  }
  for (const { identity, names, first, last } of disclosed.values()) {
    listed.push(entry(identity, "disclosed", names, { first, last }));
  }
  const identityOf = (port: string): Identity | null => {
    const recipient = recipients.byPort[port];
    return recipient === undefined
      ? null
      : {
          port: recipient.port,
          name: recipient.recipient,
          kind: recipient.kind,
          country: recipient.country,
          safeguard: recipient.safeguard,
        };
  };
  for (const [port, names] of presumed) {
    const identity = identityOf(port);
    if (identity === null) continue;
    const left = [...names].filter(
      (name) => held.has(name) && !covered.get(identity.port)?.has(name),
    );
    if (left.length === 0) continue;
    listed.push(entry(identity, "presumed", left, { first: null, last: null }));
    cover(identity.port, left);
  }
  for (const recipient of recipients.all) {
    const left = recipient.categories.filter(
      (name) => held.has(name) && !covered.get(recipient.port)?.has(name),
    );
    if (left.length === 0) continue;
    listed.push(
      entry(identityOf(recipient.port) as Identity, "declared", left, { first: null, last: null }),
    );
  }
  return listed.sort(
    (a, b) =>
      byText(a.port, b.port) ||
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      byText(a.name, b.name),
  );
};

export interface RecipientStatusesArgs {
  readonly storage: Pick<StorageTransaction, "recipients" | "deadLetterStore">;
  readonly recipients: RecipientsRuntime;
}

export interface RecipientStatusesFunction {
  (args: RecipientStatusesArgs): Promise<readonly RecipientStatus[]>;
}

/**
 * Every recipient the app declares, and every port the store recorded a disclosure to or a
 * declaration of, as `status` reports them.
 */
export const recipientStatuses: RecipientStatusesFunction = async ({ storage, recipients }) => {
  const [declared, summary] = await Promise.all([
    storage.recipients.declared(),
    storage.recipients.summary(),
  ]);
  const ports = [
    ...new Set([
      ...recipients.all.map(({ port }) => port),
      ...declared.map(({ port }) => port),
      ...summary.map(({ port }) => port),
    ]),
  ].sort(byText);
  return Promise.all(
    ports.map(async (port): Promise<RecipientStatus> => {
      const recipient = recipients.byPort[port];
      const row = declared.find((each) => each.port === port);
      return {
        port,
        declared:
          recipient === undefined || recipient.port !== port
            ? null
            : {
                name: recipient.recipient,
                kind: recipient.kind,
                country: recipient.country,
                safeguard: recipient.safeguard,
                categories: recipient.categories,
              },
        persons: summary.find((each) => each.port === port)?.persons ?? 0,
        catchingUp: row !== undefined && row.caughtUpThrough < row.presumedThrough,
        // A notice of an event that named a former key is filed under that key.
        failedNotices: (
          await Promise.all(
            [port, ...(recipient?.port === port ? recipient.formerly : [])].map((handler) =>
              storage.deadLetterStore.count({ kind: "recipient", handler, status: "failed" }),
            ),
          )
        ).reduce((sum, count) => sum + count, 0),
      };
    }),
  );
};
