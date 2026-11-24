import type { Storage } from "../../adapter/adapter.ts";
import {
  type DeclaredRecipient,
  disclosureKey,
  type RecipientPort,
  type RecipientStore,
  type StoredDisclosure,
} from "../../adapter/storage/recipient-store.ts";

// The declaration of the app's recipients a start wrote not yet, as a start on a frozen tenant
// leaves it until the thaw: each `from` renamed to its `to` in order, then `ports` declared at
// `position`, as `declare` does.
export interface PendingDeclaration {
  readonly renames: readonly { readonly from: string; readonly to: string }[];
  readonly ports: readonly RecipientPort[];
  readonly position: number;
  readonly at: string;
}

export interface WriteDeclarationFunction {
  (
    store: Pick<RecipientStore, "rename" | "declare">,
    pending: PendingDeclaration,
  ): Promise<readonly DeclaredRecipient[]>;
}

// Resolves to every port declared, as `declare` does.
export const writeDeclaration: WriteDeclarationFunction = async (store, pending) => {
  for (const { from, to } of pending.renames) await store.rename(from, to);
  return store.declare(pending.ports, pending.position, pending.at);
};

const renamedBy = (pending: PendingDeclaration) => (port: string) =>
  pending.renames.reduce((name, { from, to }) => (name === from ? to : name), port);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const COUNT_PAGE = 1_000;

const declaredAfter = (
  stored: readonly DeclaredRecipient[],
  pending: PendingDeclaration,
): DeclaredRecipient[] => {
  const recipients = new Map(stored.map((recipient) => [recipient.port, recipient]));
  for (const { from, to } of pending.renames) {
    const former = recipients.get(from);
    if (former === undefined) continue;
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
  }
  for (const { port, categories } of pending.ports) {
    const held = recipients.get(port);
    recipients.set(
      port,
      held === undefined
        ? {
            port,
            categories,
            presumedThrough: pending.position,
            caughtUpThrough: 0,
            declaredAt: pending.at,
          }
        : { ...held, categories },
    );
  }
  return [...recipients.values()].sort((a, b) => byText(a.port, b.port));
};

const disclosuresAfter = (
  stored: readonly StoredDisclosure[],
  rename: (port: string) => string,
): StoredDisclosure[] => {
  const merged = new Map<string, StoredDisclosure>();
  for (const disclosure of stored) {
    const moved = { ...disclosure, port: rename(disclosure.port) };
    const key = disclosureKey(moved);
    const held = merged.get(key);
    merged.set(
      key,
      held === undefined
        ? moved
        : {
            ...held,
            firstAt: (moved.firstAt < held.firstAt ? moved : held).firstAt,
            lastAt: (moved.lastAt > held.lastAt ? moved : held).lastAt,
          },
    );
  }
  return [...merged.values()].sort(
    (a, b) =>
      byText(a.port, b.port) || byText(a.recipient, b.recipient) || byText(a.category, b.category),
  );
};

export interface PendingRecipientsFunction {
  (store: RecipientStore, pending: () => PendingDeclaration | null): RecipientStore;
}

// `store` as it reads once the pending declaration is written.
export const pendingRecipients: PendingRecipientsFunction = (store, pending) => {
  const reading = <T>(
    read: () => Promise<T>,
    after: (stored: T, declaration: PendingDeclaration) => T | Promise<T>,
  ): Promise<T> => {
    const declaration = pending();
    return declaration === null ? read() : read().then((stored) => after(stored, declaration));
  };
  // The persons of `port` and of each port renamed to it.
  const personsOf: RecipientStore["personsOf"] = async (args) => {
    const declaration = pending();
    if (declaration === null) return store.personsOf(args);
    const rename = renamedBy(declaration);
    const sources = [
      ...new Set([args.port, ...declaration.renames.map(({ from }) => from)]),
    ].filter((port) => rename(port) === args.port);
    const pages = await Promise.all(sources.map((port) => store.personsOf({ ...args, port })));
    return [...new Set(pages.flat())].sort(byText).slice(0, args.limit);
  };
  const countOf = async (port: string): Promise<number> => {
    let persons = 0;
    for (let after: string | null = null; ; ) {
      const page = await personsOf({ port, after, limit: COUNT_PAGE });
      persons += page.length;
      if (page.length < COUNT_PAGE) return persons;
      after = page.at(-1) ?? null;
    }
  };
  return {
    ...store,
    declared: () => reading(() => store.declared(), declaredAfter),
    disclosures: (person) =>
      reading(
        () => store.disclosures(person),
        (stored, declaration) => disclosuresAfter(stored, renamedBy(declaration)),
      ),
    disclosuresOfMany: (persons) =>
      reading(
        () => store.disclosuresOfMany(persons),
        (stored, declaration) =>
          new Map(
            [...stored].map(([person, held]) => [
              person,
              disclosuresAfter(held, renamedBy(declaration)),
            ]),
          ),
      ),
    received: () =>
      reading(
        () => store.received(),
        (stored, declaration) => {
          const rename = renamedBy(declaration);
          const merged = new Map<string, Set<string>>();
          for (const [port, categories] of stored) {
            const to = rename(port);
            merged.set(to, new Set([...(merged.get(to) ?? []), ...categories]));
          }
          return new Map(
            [...merged]
              .sort(([a], [b]) => byText(a, b))
              .map(([port, categories]) => [port, [...categories].sort()]),
          );
        },
      ),
    summary: () =>
      reading(
        () => store.summary(),
        async (stored, declaration) => {
          const rename = renamedBy(declaration);
          // Counted again only where a rename merges ports, whose persons may overlap.
          const merged = new Set(
            stored.filter(({ port }) => rename(port) !== port).map(({ port }) => rename(port)),
          );
          const counted = await Promise.all(
            [...merged].map(async (port) => ({ port, persons: await countOf(port) })),
          );
          return [
            ...stored.filter(({ port }) => rename(port) === port && !merged.has(port)),
            ...counted,
          ].sort((a, b) => byText(a.port, b.port));
        },
      ),
    personsOf,
  };
};

export interface WithPendingDeclarationFunction {
  <S extends Pick<Storage, "recipients" | "transact">>(
    storage: S,
    pending: () => PendingDeclaration | null,
  ): S;
}

// `storage`, its transactions' included, reading recipients as `pendingRecipients` does.
export const withPendingDeclaration: WithPendingDeclarationFunction = (storage, pending) => ({
  ...storage,
  recipients: pendingRecipients(storage.recipients, pending),
  transact: (work) =>
    storage.transact((transaction) =>
      work({ ...transaction, recipients: pendingRecipients(transaction.recipients, pending) }),
    ),
});
