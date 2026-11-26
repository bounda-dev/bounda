import type { ForgottenRecipient } from "../../adapter/storage/recipient-store.ts";
import type { LegalBasis, PersonalCategoryName } from "../../modules/personal-data.ts";
import type {
  CountryCode,
  PersonRecipient,
  RecipientKind,
  TransferSafeguard,
} from "../../modules/recipient.ts";
import type { RecipientsRuntime } from "../recipients/build.ts";
import { recipientTransferOf } from "../recipients/transfer.ts";
import type { PersonalCategories, PersonalCategory } from "./categories.ts";
import type { TenantExportForgottenRecipient, TenantExportRecipient } from "./tenant-export.ts";

// The recipients the `person` parts list, summed as each page of them is built: it holds one entry
// per identity and status, however many persons there are.
export interface RecipientTally {
  // Those one person is listed with, as their part lists them.
  add(listed: readonly PersonRecipient[]): void;
  recipients(): readonly TenantExportRecipient[];
}

export interface TallyRecipientsArgs {
  readonly recipients: Pick<RecipientsRuntime, "all">;
  readonly categories: Pick<PersonalCategories, "of">;
}

export interface TallyRecipientsFunction {
  (args: TallyRecipientsArgs): RecipientTally;
}

type Identity = Pick<PersonRecipient, "port" | "name" | "kind" | "country" | "transfer">;

interface Tallied {
  readonly recipient: PersonRecipient;
  readonly categories: Map<string, LegalBasis | null>;
  persons: number;
  first: string | null;
  last: string | null;
}

const identityOf = ({ port, name, kind, country, transfer }: Identity): string =>
  JSON.stringify([port, name, kind, country, transfer?.safeguard ?? null]);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const STATUS_ORDER: Readonly<Record<PersonRecipient["status"], number>> = {
  disclosed: 0,
  presumed: 1,
  declared: 2,
};

// The entries of one key share a status, and only a disclosed one has times, so `a` and `b` are
// both timestamps or both `null`.
const earlier = (a: string | null, b: string | null): string | null =>
  (b as string) < (a as string) ? b : a;

const later = (a: string | null, b: string | null): string | null =>
  (b as string) > (a as string) ? b : a;

export const tallyRecipients: TallyRecipientsFunction = ({ recipients, categories }) => {
  const tallied = new Map<string, Tallied>();
  return {
    add: (listed) => {
      for (const recipient of listed) {
        const key = JSON.stringify([identityOf(recipient), recipient.status]);
        const held = tallied.get(key);
        if (held === undefined) {
          tallied.set(key, {
            recipient,
            categories: new Map(recipient.categories.map(({ name, basis }) => [name, basis])),
            persons: 1,
            first: recipient.firstDisclosedAt,
            last: recipient.lastDisclosedAt,
          });
          continue;
        }
        for (const { name, basis } of recipient.categories) held.categories.set(name, basis);
        held.persons += 1;
        held.first = earlier(held.first, recipient.firstDisclosedAt);
        held.last = later(held.last, recipient.lastDisclosedAt);
      }
    },
    recipients: () => {
      const listed: TenantExportRecipient[] = [...tallied.values()].map(
        ({ recipient, categories: named, persons, first, last }) => ({
          ...recipient,
          categories: [...named.keys()].sort(byText).map((name) => ({
            name: name as PersonalCategoryName,
            basis: named.get(name) as LegalBasis | null,
          })),
          firstDisclosedAt: first,
          lastDisclosedAt: last,
          persons,
        }),
      );
      const identities = new Set(listed.map(identityOf));
      for (const declared of recipients.all) {
        const recipient: Identity = {
          port: declared.port,
          name: declared.recipient,
          kind: declared.kind,
          country: declared.country,
          transfer: recipientTransferOf(declared.country, declared.safeguard),
        };
        if (identities.has(identityOf(recipient))) continue;
        listed.push({
          ...recipient,
          status: "declared",
          categories: [...declared.categories].sort(byText).map((name) => ({
            name: name as PersonalCategoryName,
            // `buildRecipients` refuses a declaration that names a category the app lacks.
            basis: (categories.of(name) as PersonalCategory).basis,
          })),
          firstDisclosedAt: null,
          lastDisclosedAt: null,
          declared: true,
          persons: 0,
        });
      }
      return listed.sort(
        (a, b) =>
          byText(a.port, b.port) ||
          STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
          byText(a.name, b.name) ||
          byText(identityOf(a), identityOf(b)),
      );
    },
  };
};

export interface ForgottenRecipientsArgs {
  readonly recipients: Pick<RecipientsRuntime, "byPort">;
  readonly categories: Pick<PersonalCategories, "of">;
  // As `RecipientStore.forgottenCounts` resolves them.
  readonly counted: readonly ForgottenRecipient[];
}

export interface ForgottenRecipientsFunction {
  (args: ForgottenRecipientsArgs): readonly TenantExportForgottenRecipient[];
}

interface Summed {
  readonly recipient: Omit<TenantExportForgottenRecipient, "persons" | "categories">;
  persons: number;
  readonly categories: Map<string, number>;
}

/**
 * The counts the store holds of forgotten persons, one entry per identity and status, under the
 * port each key is now, in the order of the `recipient` parts.
 */
export const forgottenRecipients: ForgottenRecipientsFunction = ({
  recipients,
  categories,
  counted,
}) => {
  const summed = new Map<string, Summed>();
  for (const row of counted) {
    const port = recipients.byPort[row.port]?.port ?? row.port;
    const recipient: Summed["recipient"] = {
      port,
      name: row.recipient,
      kind: row.kind as RecipientKind,
      country: row.country as CountryCode,
      transfer: recipientTransferOf(
        row.country as CountryCode,
        row.safeguard as TransferSafeguard | null,
      ),
      status: row.status,
      declared: recipients.byPort[port] !== undefined,
    };
    const key = JSON.stringify([identityOf(recipient), row.status]);
    const held = summed.get(key) ?? { recipient, persons: 0, categories: new Map() };
    summed.set(key, held);
    if (row.category === null) held.persons += row.persons;
    else held.categories.set(row.category, (held.categories.get(row.category) ?? 0) + row.persons);
  }
  return [...summed.values()]
    .map(({ recipient, persons, categories: named }) => ({
      ...recipient,
      persons,
      categories: [...named.keys()].sort(byText).map((name) => ({
        name: name as PersonalCategoryName,
        basis: categories.of(name)?.basis ?? null,
        persons: named.get(name) as number,
      })),
    }))
    .sort(
      (a, b) =>
        byText(a.port, b.port) ||
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        byText(a.name, b.name) ||
        byText(identityOf(a), identityOf(b)),
    );
};
