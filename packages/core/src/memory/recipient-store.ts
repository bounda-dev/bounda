import {
  type DeclaredRecipient,
  type Disclosure,
  disclosureKey,
  type RecipientStore,
  type StoredDisclosure,
} from "../adapter/storage/recipient-store.ts";

export interface KeptRecipientStore {
  readonly store: RecipientStore;
  /**
   * Remembers every row as it is now, and resolves to what puts them back.
   */
  snapshot(): () => void;
  disclosureRows(): readonly Readonly<Record<string, unknown>>[];
  recipientRows(): readonly Readonly<Record<string, unknown>>[];
}

export interface CreateKeptRecipientStoreFunction {
  (): KeptRecipientStore;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byDisclosure = (a: StoredDisclosure, b: StoredDisclosure): number =>
  byText(a.port, b.port) || byText(a.recipient, b.recipient) || byText(a.category, b.category);

export const createKeptRecipientStore: CreateKeptRecipientStoreFunction = () => {
  let disclosures = new Map<string, StoredDisclosure>();
  let recipients = new Map<string, DeclaredRecipient>();
  const declared = async (): Promise<readonly DeclaredRecipient[]> =>
    [...recipients.values()].sort((a, b) => byText(a.port, b.port));
  return {
    store: {
      disclose: async (rows, at) => {
        const added: Disclosure[] = [];
        for (const row of rows) {
          const key = disclosureKey(row);
          const held = disclosures.get(key);
          if (held === undefined) {
            disclosures.set(key, { ...row, firstAt: at, lastAt: at });
            added.push(row);
          } else if (held.lastAt < at) {
            disclosures.set(key, { ...held, lastAt: at });
          }
        }
        return added;
      },
      disclosures: async (person) =>
        [...disclosures.values()].filter((row) => row.person === person).sort(byDisclosure),
      forget: async (person, categories) => {
        for (const [key, row] of disclosures) {
          if (row.person === person && (categories === null || categories.includes(row.category))) {
            disclosures.delete(key);
          }
        }
      },
      declare: async (ports, position, at) => {
        for (const { port, categories } of ports) {
          const held = recipients.get(port);
          recipients.set(
            port,
            held === undefined
              ? { port, categories, presumedThrough: position, caughtUpThrough: 0, declaredAt: at }
              : { ...held, categories },
          );
        }
        return declared();
      },
      declared,
      presumeThrough: async (position) => {
        for (const [port, row] of recipients) {
          if (row.presumedThrough < position) {
            recipients.set(port, { ...row, presumedThrough: position });
          }
        }
      },
      rename: async (from, to) => {
        for (const [key, row] of [...disclosures]) {
          if (row.port !== from) continue;
          disclosures.delete(key);
          const moved = { ...row, port: to };
          const held = disclosures.get(disclosureKey(moved));
          disclosures.set(
            disclosureKey(moved),
            held === undefined
              ? moved
              : {
                  ...held,
                  firstAt: row.firstAt < held.firstAt ? row.firstAt : held.firstAt,
                  lastAt: row.lastAt > held.lastAt ? row.lastAt : held.lastAt,
                },
          );
        }
        const former = recipients.get(from);
        if (former === undefined) return;
        recipients.delete(from);
        const held = recipients.get(to);
        recipients.set(
          to,
          held === undefined
            ? { ...former, port: to }
            : {
                ...held,
                presumedThrough: Math.max(held.presumedThrough, former.presumedThrough),
                caughtUpThrough: Math.max(held.caughtUpThrough, former.caughtUpThrough),
              },
        );
      },
      caughtUp: async (port, position) => {
        const held = recipients.get(port);
        if (held !== undefined && held.caughtUpThrough < position) {
          recipients.set(port, { ...held, caughtUpThrough: position });
        }
      },
      summary: async () => {
        const persons = new Map<string, Set<string>>();
        for (const { port, person } of disclosures.values()) {
          persons.set(port, (persons.get(port) ?? new Set()).add(person));
        }
        return [...persons.entries()]
          .sort(([a], [b]) => byText(a, b))
          .map(([port, named]) => ({ port, persons: named.size }));
      },
    },
    snapshot: () => {
      const kept = { disclosures: new Map(disclosures), recipients: new Map(recipients) };
      return () => {
        disclosures = kept.disclosures;
        recipients = kept.recipients;
      };
    },
    disclosureRows: () =>
      [...disclosures.values()].sort(byDisclosure).map((row) => ({
        person: row.person,
        port: row.port,
        recipient: row.recipient,
        kind: row.kind,
        country: row.country,
        safeguard: row.safeguard,
        category: row.category,
        first_at: row.firstAt,
        last_at: row.lastAt,
      })),
    recipientRows: () =>
      [...recipients.values()]
        .sort((a, b) => byText(a.port, b.port))
        .map((row) => ({
          port: row.port,
          categories: JSON.stringify(row.categories),
          presumed_through: row.presumedThrough,
          caught_up_through: row.caughtUpThrough,
          declared_at: row.declaredAt,
        })),
  };
};
