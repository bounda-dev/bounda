import type { StorageTransaction } from "../../adapter/adapter.ts";
import type { PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
import type { PersonalCategoryName } from "../../modules/personal-data.ts";
import type {
  CountryCode,
  PersonRecipient,
  RecipientKind,
  TransferSafeguard,
} from "../../modules/recipient.ts";
import type { PersonalCategories } from "../personal-data/categories.ts";
import { presumedOf } from "./addressing.ts";
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
}) => {
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
  for (const row of await storage.recipients.disclosures(personId)) {
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
  for (const [port, names] of await presumedOf(storage, personId)) {
    const identity = identityOf(port);
    if (identity === null) continue;
    const left = [...names].filter((name) => !covered.get(identity.port)?.has(name));
    if (left.length === 0) continue;
    listed.push(entry(identity, "presumed", left, { first: null, last: null }));
    cover(identity.port, left);
  }
  const held = new Set((await storage.personalKeys.list(personId)).map(({ category }) => category));
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
