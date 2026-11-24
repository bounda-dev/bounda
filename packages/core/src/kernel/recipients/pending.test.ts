import { describe, expect, it } from "vitest";
import type { Disclosure, RecipientStore } from "../../adapter/storage/recipient-store.ts";
import { createKeptRecipientStore } from "../../memory/recipient-store.ts";
import { type PendingDeclaration, pendingRecipients, writeDeclaration } from "./pending.ts";

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

const PENDING: PendingDeclaration = {
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
    expect(await readAll(pendingRecipients(pending, () => PENDING))).toEqual(
      await readAll(written),
    );
    expect((await written.declared()).map(({ port }) => port)).toEqual([
      "customer.crm",
      "customer.newsletter",
    ]);
  });

  it("are the store's as they are once nothing is pending", async () => {
    const [pending, written] = await stores();
    expect(await readAll(pendingRecipients(pending, () => null))).toEqual(await readAll(written));
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
    const summary = await pendingRecipients(counting, () => PENDING).summary();
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
    await pendingRecipients(counting, () => null).summary();
    expect(listed).toEqual([]);
  });
});
