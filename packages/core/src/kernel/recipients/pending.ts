import type { Storage } from "../../adapter/adapter.ts";
import type { ClaimKey } from "../../adapter/storage/inbox-ledger.ts";
import {
  type DeclaredRecipient,
  disclosureKey,
  type RecipientStore,
  type StoredDisclosure,
} from "../../adapter/storage/recipient-store.ts";
import type { PendingRecipientDeclaration } from "../../adapter/storage/tenant-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import type { TenantKeys } from "../personal-data/tenant-keys.ts";

export interface WriteDeclarationFunction {
  (
    store: Pick<RecipientStore, "rename" | "declare">,
    pending: Omit<PendingRecipientDeclaration, "id">,
  ): Promise<readonly DeclaredRecipient[]>;
}

// Resolves to every port declared, as `declare` does.
export const writeDeclaration: WriteDeclarationFunction = async (store, pending) => {
  for (const { from, to } of pending.renames) await store.rename(from, to);
  return store.declare(pending.ports, pending.position, pending.at);
};

// Where the declarations a frozen tenant's starts could not write wait, read alike by every
// instance: the tenant key record, or this instance alone for an app that keeps none.
export interface PendingRecipients {
  // Those held, oldest first, as read last.
  held(): readonly PendingRecipientDeclaration[];
  refresh(): Promise<void>;
  // Rejects with `TenantForgottenError` once the tenant is forgotten.
  add(declaration: PendingRecipientDeclaration): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
}

export interface LocalPendingRecipientsFunction {
  (): PendingRecipients;
}

export const localPendingRecipients: LocalPendingRecipientsFunction = () => {
  let held: readonly PendingRecipientDeclaration[] = [];
  return {
    held: () => held,
    refresh: async () => undefined,
    add: async (declaration) => {
      held = [...held, declaration];
    },
    remove: async (ids) => {
      held = held.filter(({ id }) => !ids.includes(id));
    },
  };
};

export interface RecordedPendingRecipientsFunction {
  (
    keys: Pick<
      TenantKeys,
      "pendingRecipients" | "refresh" | "addPendingRecipients" | "removePendingRecipients"
    >,
  ): PendingRecipients;
}

// Those the tenant key record holds, which every instance reads, and which a frozen tenant may
// still write.
export const recordedPendingRecipients: RecordedPendingRecipientsFunction = (keys) => ({
  held: () => keys.pendingRecipients(),
  refresh: async () => {
    await keys.refresh();
  },
  add: (declaration) => keys.addPendingRecipients(declaration),
  remove: (ids) => keys.removePendingRecipients(ids),
});

// The inbox ledger's handler under which each declaration is claimed, by its id, as it is written.
export const RECIPIENT_DECLARATION_HANDLER = "bounda:recipient-declaration";

// How long the instance that claimed a declaration owns it, as a crash leaves it.
export const DECLARATION_LEASE_MS = 30_000;

// What a claim whose declaration could not be written records as its error.
export const DECLARATION_FAILED = "the declaration of recipients could not be written";

// How long a writer that must wait for another's declaration waits between looks.
export const DECLARATION_RETRY_MS = 250;

const claimOf = ({ id }: PendingRecipientDeclaration): ClaimKey => ({
  handler: RECIPIENT_DECLARATION_HANDLER,
  eventId: id,
});

export interface UnwrittenFunction {
  (
    inboxLedger: Pick<Storage["inboxLedger"], "get">,
    held: readonly PendingRecipientDeclaration[],
  ): Promise<readonly PendingRecipientDeclaration[]>;
}

// Those of `held` the database holds not yet: one written may wait a moment to leave the record.
export const unwritten: UnwrittenFunction = async (inboxLedger, held) => {
  const left: PendingRecipientDeclaration[] = [];
  for (const declaration of held) {
    if ((await inboxLedger.get(claimOf(declaration)))?.status !== "succeeded") {
      left.push(declaration);
    }
  }
  return left;
};

// Writes `declaration` in one transaction with its claim's completion, so of every instance that
// writes it one does, once; resolves to whether another holds its claim, written then by none.
const heldElsewhere = async (
  storage: Pick<Storage, "transact" | "inboxLedger">,
  declaration: PendingRecipientDeclaration,
  clock: Clock,
): Promise<boolean> => {
  const key = claimOf(declaration);
  const claimId = await storage.inboxLedger.tryClaim({
    ...key,
    now: clock.now(),
    leaseMs: DECLARATION_LEASE_MS,
  });
  // A claim that succeeded is never handed out again.
  if (claimId === null) return (await storage.inboxLedger.get(key))?.status !== "succeeded";
  try {
    await storage.transact(async (transaction) => {
      await writeDeclaration(transaction.recipients, declaration);
      await transaction.inboxLedger.complete({ ...key, claimId });
    });
  } catch (error) {
    // Handed out again at once, rather than once its lease ends.
    await storage.inboxLedger
      .fail({ ...key, claimId, error: DECLARATION_FAILED })
      .catch(() => undefined);
    throw error;
  }
  return false;
};

export interface WritePendingRecipientsArgs {
  readonly storage: Pick<Storage, "transact" | "inboxLedger">;
  readonly pending: PendingRecipients;
  readonly clock: Clock;
  // Whether to wait for a declaration another instance is writing, as a start must before it
  // writes its own, rather than leave it to the next pass.
  readonly wait: boolean;
}

export interface WritePendingRecipientsFunction {
  (args: WritePendingRecipientsArgs): Promise<boolean>;
}

// Writes the declarations `pending` holds to the database, oldest first, each once whatever other
// instance writes it too, and removes them from `pending`; resolves to whether none is left. One
// another instance is writing stops it there, so none is written before an older one: it waits
// for it when `wait`, and resolves `false` otherwise. Rejects as a write of the storage does, as
// a frozen tenant's does.
export const writePendingRecipients: WritePendingRecipientsFunction = async ({
  storage,
  pending,
  clock,
  wait,
}) => {
  for (;;) {
    const [declaration] = pending.held();
    if (declaration === undefined) return true;
    if (await heldElsewhere(storage, declaration, clock)) {
      if (!wait) return false;
      await new Promise<void>((resume) => {
        clock.after(DECLARATION_RETRY_MS, resume);
      });
      await pending.refresh();
    } else {
      await pending.remove([declaration.id]);
    }
  }
};

const renamedBy =
  (pending: readonly Pick<PendingRecipientDeclaration, "renames">[]) =>
  (port: string): string =>
    pending.reduce(
      (renamed, { renames }) =>
        renames.reduce((name, { from, to }) => (name === from ? to : name), renamed),
      port,
    );

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const COUNT_PAGE = 1_000;

const declaredAfterOne = (
  stored: readonly DeclaredRecipient[],
  pending: PendingRecipientDeclaration,
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

const declaredAfter = (
  stored: readonly DeclaredRecipient[],
  pending: readonly PendingRecipientDeclaration[],
): readonly DeclaredRecipient[] => pending.reduce(declaredAfterOne, stored);

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

export interface PendingRecipientsStoreFunction {
  (
    store: RecipientStore,
    pending: () => Promise<readonly PendingRecipientDeclaration[]>,
  ): RecipientStore;
}

// `store` as it reads once the pending declarations are written, in order.
export const pendingRecipientsStore: PendingRecipientsStoreFunction = (store, pending) => {
  const reading = async <T>(
    read: () => Promise<T>,
    after: (stored: T, declarations: readonly PendingRecipientDeclaration[]) => T | Promise<T>,
  ): Promise<T> => after(await read(), await pending());
  // The persons of `port` and of each port renamed to it.
  const personsOf: RecipientStore["personsOf"] = async (args) => {
    const declarations = await pending();
    const rename = renamedBy(declarations);
    const sources = [
      ...new Set([
        args.port,
        ...declarations.flatMap(({ renames }) => renames.map(({ from }) => from)),
      ]),
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
        (stored, declarations) => disclosuresAfter(stored, renamedBy(declarations)),
      ),
    disclosuresOfMany: (persons) =>
      reading(
        () => store.disclosuresOfMany(persons),
        (stored, declarations) =>
          new Map(
            [...stored].map(([person, held]) => [
              person,
              disclosuresAfter(held, renamedBy(declarations)),
            ]),
          ),
      ),
    received: () =>
      reading(
        () => store.received(),
        (stored, declarations) => {
          const rename = renamedBy(declarations);
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
        async (stored, declarations) => {
          const rename = renamedBy(declarations);
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

export interface WithPendingDeclarationsFunction {
  <S extends Pick<Storage, "recipients" | "transact" | "inboxLedger">>(
    storage: S,
    held: () => readonly PendingRecipientDeclaration[],
  ): S;
}

// `storage`, its transactions' included, reading recipients as `pendingRecipientsStore` does with
// those of `held` not written yet, as each reads its inbox ledger.
export const withPendingDeclarations: WithPendingDeclarationsFunction = (storage, held) => {
  const pending = (inboxLedger: Pick<Storage["inboxLedger"], "get">) => () =>
    unwritten(inboxLedger, held());
  return {
    ...storage,
    recipients: pendingRecipientsStore(storage.recipients, pending(storage.inboxLedger)),
    transact: (work) =>
      storage.transact((transaction) =>
        work({
          ...transaction,
          recipients: pendingRecipientsStore(
            transaction.recipients,
            pending(transaction.inboxLedger),
          ),
        }),
      ),
  };
};
