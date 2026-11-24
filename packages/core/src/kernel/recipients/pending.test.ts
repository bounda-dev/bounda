import { describe, expect, it } from "vitest";
import type { Storage } from "../../adapter/adapter.ts";
import type { Disclosure, RecipientStore } from "../../adapter/storage/recipient-store.ts";
import type { PendingRecipientDeclaration } from "../../adapter/storage/tenant-key-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { memory } from "../../memory/index.ts";
import { createKeptRecipientStore } from "../../memory/recipient-store.ts";
import {
  DECLARATION_FAILED,
  DECLARATION_LEASE_MS,
  DECLARATION_RETRY_MS,
  localPendingRecipients,
  pendingRecipientsStore,
  RECIPIENT_DECLARATION_HANDLER,
  withPendingDeclarations,
  writeDeclaration,
  writePendingRecipients,
} from "./pending.ts";

const START = new Date("2026-03-01T00:00:00.000Z");

const disclosure = (
  person: string,
  port: string,
  category: string,
  recipient = "Mailchimp",
): Disclosure => ({
  person,
  port,
  recipient,
  kind: "processor",
  country: "US",
  safeguard: null,
  category,
});

const PENDING: PendingRecipientDeclaration = {
  id: "d-1",
  renames: [
    { from: "customer.mailer", to: "customer.newsletter" },
    { from: "customer.gone", to: "customer.newsletter" },
  ],
  ports: [
    { port: "customer.newsletter", categories: ["contact", "profile"] },
    { port: "customer.crm", categories: ["contact"] },
  ],
  position: 9,
  at: "2026-03-02T00:00:00.000Z",
};

// The same rows in two stores, one of which then writes the declaration.
const stores = async (): Promise<readonly [RecipientStore, RecipientStore]> => {
  const pair = [createKeptRecipientStore().store, createKeptRecipientStore().store] as const;
  for (const store of pair) {
    await store.declare(
      [{ port: "customer.mailer", categories: ["contact"] }],
      3,
      "2026-03-01T00:00:00.000Z",
    );
    await store.declare(
      [{ port: "customer.newsletter", categories: ["contact"] }],
      5,
      "2026-03-01T00:00:00.000Z",
    );
    await store.caughtUp("customer.mailer", 2);
    await store.disclose(
      [
        disclosure("p-1", "customer.mailer", "contact"),
        disclosure("p-3", "customer.gone", "profile"),
        disclosure("p-4", "customer.crm", "contact"),
        // Between the former port and the new one: renaming moves the mailer's past it.
        disclosure("p-1", "customer.mz", "contact"),
        disclosure("p-1", "customer.mailer", "profile"),
        disclosure("p-1", "customer.mailer", "profile", "Brevo"),
        disclosure("p-5", "customer.zeta", "contact"),
      ],
      "2026-03-01T10:00:00.000Z",
    );
    // The same disclosure under the former port, first earlier and last earlier than under the
    // new one, at 08:00 and 12:00.
    await store.disclose(
      [disclosure("p-2", "customer.mailer", "contact")],
      "2026-03-01T06:00:00.000Z",
    );
    await store.disclose(
      [disclosure("p-2", "customer.mailer", "contact")],
      "2026-03-01T09:00:00.000Z",
    );
    await store.disclose(
      [disclosure("p-2", "customer.newsletter", "contact")],
      "2026-03-01T08:00:00.000Z",
    );
    await store.disclose(
      [disclosure("p-2", "customer.newsletter", "contact")],
      "2026-03-01T12:00:00.000Z",
    );
  }
  return pair;
};

const readAll = async (store: RecipientStore) => ({
  declared: await store.declared(),
  disclosures: await Promise.all(
    ["p-1", "p-2", "p-3", "p-5"].map((person) => store.disclosures(person)),
  ),
  many: [...(await store.disclosuresOfMany(["p-1", "p-2", "p-3", "p-4"]))],
  received: [...(await store.received())],
  summary: await store.summary(),
  persons: await Promise.all(
    ["customer.newsletter", "customer.mailer", "customer.gone", "customer.crm"].map((port) =>
      store.personsOf({ port, after: null, limit: 10 }),
    ),
  ),
  paged: await store.personsOf({ port: "customer.newsletter", after: "p-1", limit: 1 }),
});

describe("the recipients a pending declaration reads", () => {
  it("are those the store holds once it is written, for every reader", async () => {
    const [pending, written] = await stores();
    await writeDeclaration(written, PENDING);
    expect(await readAll(pendingRecipientsStore(pending, async () => [PENDING]))).toEqual(
      await readAll(written),
    );
    expect((await written.declared()).map(({ port }) => port)).toEqual([
      "customer.crm",
      "customer.newsletter",
    ]);
  });

  it("are those the store holds once each of several is written, in order, a rename of one renaming what an earlier declared", async () => {
    const [pending, written] = await stores();
    const LATER: PendingRecipientDeclaration = {
      id: "d-2",
      renames: [{ from: "customer.newsletter", to: "customer.letters" }],
      ports: [
        { port: "customer.letters", categories: ["contact"] },
        { port: "customer.crm", categories: ["contact", "profile"] },
      ],
      position: 9,
      at: "2026-03-03T00:00:00.000Z",
    };
    await writeDeclaration(written, PENDING);
    await writeDeclaration(written, LATER);
    const read = await readAll(pendingRecipientsStore(pending, async () => [PENDING, LATER]));
    expect(read).toEqual(await readAll(written));
    expect(
      await pendingRecipientsStore(pending, async () => [PENDING, LATER]).personsOf({
        port: "customer.letters",
        after: null,
        limit: 10,
      }),
    ).toEqual(await written.personsOf({ port: "customer.letters", after: null, limit: 10 }));
    expect((await written.declared()).map(({ port, categories }) => [port, categories])).toEqual([
      ["customer.crm", ["contact", "profile"]],
      ["customer.letters", ["contact"]],
    ]);
  });

  it("are the store's as they are once nothing is pending", async () => {
    const [pending, written] = await stores();
    expect(await readAll(pendingRecipientsStore(pending, async () => []))).toEqual(
      await readAll(written),
    );
  });

  it("count every person of a port and of those renamed to it, past a page", async () => {
    const [store] = await stores();
    const persons = Array.from(
      { length: 1_001 },
      (_, index) => `q-${String(index).padStart(4, "0")}`,
    );
    await store.disclose(
      persons.map((person) => disclosure(person, "customer.gone", "profile")),
      "2026-03-01T10:00:00.000Z",
    );
    let listed: string[] = [];
    const counting: RecipientStore = {
      ...store,
      personsOf: (args) => {
        listed.push(args.port);
        return store.personsOf(args);
      },
    };
    const summary = await pendingRecipientsStore(counting, async () => [PENDING]).summary();
    expect(summary).toEqual([
      { port: "customer.crm", persons: 1 },
      { port: "customer.mz", persons: 1 },
      { port: "customer.newsletter", persons: 1_004 },
      { port: "customer.zeta", persons: 1 },
    ]);
    // Only the ports a rename merges are listed again.
    expect([...new Set(listed)].sort()).toEqual([
      "customer.gone",
      "customer.mailer",
      "customer.newsletter",
    ]);
    listed = [];
    await pendingRecipientsStore(counting, async () => []).summary();
    expect(listed).toEqual([]);
  });
});

const declaration = (
  id: string,
  categories: readonly string[],
  at = "2026-03-02T00:00:00.000Z",
): PendingRecipientDeclaration => ({
  id,
  renames: [],
  ports: [{ port: "customer.crm", categories }],
  position: 4,
  at,
});

const categoriesOf = async (storage: Storage) =>
  (await storage.recipients.declared()).map(({ port, categories }) => [port, categories]);

// What `writing` resolves to, the clock moved on between its looks until it does.
const waitedFor = async <T>(
  clock: { advance(milliseconds: number): void },
  writing: Promise<T>,
) => {
  let done = false;
  const settled = writing.finally(() => {
    done = true;
  });
  while (!done) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.advance(DECLARATION_RETRY_MS);
  }
  return settled;
};

describe("writePendingRecipients", () => {
  it("writes each declaration held once, oldest first, and removes them, whoever else writes them at once", async () => {
    const storage = await memory().createStorage();
    const clock = createFixedClock(START);
    const pending = localPendingRecipients();
    await pending.add(declaration("d-1", ["contact"]));
    await pending.add(declaration("d-2", ["contact", "profile"]));
    let declared = 0;
    const counting: Storage = {
      ...storage,
      transact: (work) =>
        storage.transact((transaction) =>
          work({
            ...transaction,
            recipients: {
              ...transaction.recipients,
              declare: (...args) => {
                declared += 1;
                return transaction.recipients.declare(...args);
              },
            },
          }),
        ),
    };
    const results = await waitedFor(
      clock,
      Promise.all([
        writePendingRecipients({ storage: counting, pending, clock, wait: true }),
        writePendingRecipients({ storage: counting, pending, clock, wait: true }),
      ]),
    );
    expect(results).toEqual([true, true]);
    expect(declared).toBe(2);
    expect(pending.held()).toEqual([]);
    expect(await categoriesOf(storage)).toEqual([["customer.crm", ["contact", "profile"]]]);
    // Written already: a writer that still held them writes nothing again.
    const stale = localPendingRecipients();
    await stale.add(declaration("d-1", ["contact"]));
    expect(
      await writePendingRecipients({ storage: counting, pending: stale, clock, wait: false }),
    ).toBe(true);
    expect(declared).toBe(2);
    expect(stale.held()).toEqual([]);
    expect(await categoriesOf(storage)).toEqual([["customer.crm", ["contact", "profile"]]]);
  });

  it("stops at one another instance is writing, writing none after it, and waits for it when told to", async () => {
    const storage = await memory().createStorage();
    const clock = createFixedClock(START);
    const pending = localPendingRecipients();
    await pending.add(declaration("d-1", ["contact"]));
    await pending.add(declaration("d-2", ["contact", "profile"]));
    const claimId = await storage.inboxLedger.tryClaim({
      handler: RECIPIENT_DECLARATION_HANDLER,
      eventId: "d-1",
      now: clock.now(),
      leaseMs: DECLARATION_LEASE_MS,
    });
    expect(await writePendingRecipients({ storage, pending, clock, wait: false })).toBe(false);
    expect(pending.held().map(({ id }) => id)).toEqual(["d-1", "d-2"]);
    expect(await storage.recipients.declared()).toEqual([]);
    const waiting = writePendingRecipients({ storage, pending, clock, wait: true });
    // The other instance writes it meanwhile.
    await storage.transact(async (transaction) => {
      await writeDeclaration(transaction.recipients, declaration("d-1", ["contact"]));
      await transaction.inboxLedger.complete({
        handler: RECIPIENT_DECLARATION_HANDLER,
        eventId: "d-1",
        claimId: claimId as string,
      });
    });
    expect(await waitedFor(clock, waiting)).toBe(true);
    expect(pending.held()).toEqual([]);
    expect(await categoriesOf(storage)).toEqual([["customer.crm", ["contact", "profile"]]]);
  });

  it("writes one whose writer crashed once its lease ended, and lets another write one whose write failed at once", async () => {
    const storage = await memory().createStorage();
    const clock = createFixedClock(START);
    const pending = localPendingRecipients();
    await pending.add(declaration("d-1", ["contact"]));
    await storage.inboxLedger.tryClaim({
      handler: RECIPIENT_DECLARATION_HANDLER,
      eventId: "d-1",
      now: clock.now(),
      leaseMs: DECLARATION_LEASE_MS,
    });
    const waiting = writePendingRecipients({ storage, pending, clock, wait: true });
    expect(await waitedFor(clock, waiting)).toBe(true);
    expect(await categoriesOf(storage)).toEqual([["customer.crm", ["contact"]]]);

    await pending.add(declaration("d-2", ["profile"]));
    const failing: Storage = {
      ...storage,
      transact: () => Promise.reject(new Error("the database is down")),
    };
    await expect(
      writePendingRecipients({ storage: failing, pending, clock, wait: false }),
    ).rejects.toThrow("the database is down");
    expect(
      await storage.inboxLedger.get({ handler: RECIPIENT_DECLARATION_HANDLER, eventId: "d-2" }),
    ).toMatchObject({ status: "failed", lastError: DECLARATION_FAILED });
    expect(await writePendingRecipients({ storage, pending, clock, wait: false })).toBe(true);
    expect(await categoriesOf(storage)).toEqual([["customer.crm", ["profile"]]]);
  });

  it("reads through a storage only those it has not written, in its transactions too", async () => {
    const storage = await memory().createStorage();
    const clock = createFixedClock(START);
    const held = [declaration("d-1", ["contact"]), declaration("d-2", ["contact", "profile"])];
    const reading = withPendingDeclarations(storage, () => held);
    expect(await categoriesOf(reading)).toEqual([["customer.crm", ["contact", "profile"]]]);
    const first = localPendingRecipients();
    await first.add(held[0] as PendingRecipientDeclaration);
    await writePendingRecipients({ storage, pending: first, clock, wait: false });
    await storage.recipients.declare(
      [{ port: "customer.crm", categories: ["invoices"] }],
      4,
      "2026-03-03T00:00:00.000Z",
    );
    // The first written, then overwritten by a later declaration: it reads no more.
    expect(
      await categoriesOf(
        withPendingDeclarations(storage, () => [held[0] as PendingRecipientDeclaration]),
      ),
    ).toEqual([["customer.crm", ["invoices"]]]);
    expect(await categoriesOf(reading)).toEqual([["customer.crm", ["contact", "profile"]]]);
    expect(
      await reading.transact(async (transaction) =>
        (await transaction.recipients.declared()).map(({ categories }) => categories),
      ),
    ).toEqual([["contact", "profile"]]);
    const all = localPendingRecipients();
    for (const each of held) await all.add(each);
    await writePendingRecipients({ storage, pending: all, clock, wait: false });
    expect(await categoriesOf(reading)).toEqual([["customer.crm", ["contact", "profile"]]]);
    expect(await categoriesOf(withPendingDeclarations(storage, () => []))).toEqual(
      await categoriesOf(reading),
    );
  });
});

describe("localPendingRecipients", () => {
  it("holds what is added, in order, until removed", async () => {
    const pending = localPendingRecipients();
    await pending.refresh();
    expect(pending.held()).toEqual([]);
    await pending.add(declaration("d-1", ["contact"]));
    await pending.add(declaration("d-2", ["profile"]));
    await pending.remove(["d-1", "d-9"]);
    expect(pending.held().map(({ id }) => id)).toEqual(["d-2"]);
  });
});
