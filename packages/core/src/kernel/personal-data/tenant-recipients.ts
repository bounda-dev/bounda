import type { LegalBasis, PersonalCategoryName } from "../../modules/personal-data.ts";
import { type PersonRecipient, TRANSFER_ARTICLES } from "../../modules/recipient.ts";
import type { RecipientsRuntime } from "../recipients/build.ts";
import type { PersonalCategories } from "./categories.ts";
import type { TenantExportRecipient } from "./tenant-export.ts";

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

const earlier = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null || a < b ? a : b;

const later = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null || a > b ? a : b;

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
          transfer:
            declared.safeguard === null
              ? null
              : { safeguard: declared.safeguard, article: TRANSFER_ARTICLES[declared.safeguard] },
        };
        if (identities.has(identityOf(recipient))) continue;
        listed.push({
          ...recipient,
          status: "declared",
          categories: [...declared.categories].sort(byText).map((name) => ({
            name: name as PersonalCategoryName,
            basis: categories.of(name)?.basis ?? null,
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
          byText(a.kind, b.kind) ||
          byText(a.country, b.country) ||
          byText(a.transfer?.safeguard ?? "", b.transfer?.safeguard ?? ""),
      );
    },
  };
};
