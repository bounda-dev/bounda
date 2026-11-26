import { beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../adapter.ts";
import type { Disclosure, ForgottenRecipient } from "../storage/recipient-store.ts";

export interface RecipientStoreContractArgs {
  readonly create: () => Promise<Pick<Storage, "recipients" | "transact">>;
}

export interface RecipientStoreContractFunction {
  (args: RecipientStoreContractArgs): void;
}

const at = (day: number): string => new Date(Date.UTC(2026, 1, 1 + day)).toISOString();

const disclosure = (overrides: Partial<Disclosure> = {}): Disclosure => ({
  person: "c-1",
  port: "customer.mailer",
  recipient: "Mailchimp",
  kind: "processor",
  country: "US",
  safeguard: "standard-contractual-clauses",
  category: "contact",
  ...overrides,
});

const counted = (overrides: Partial<ForgottenRecipient> = {}): ForgottenRecipient => ({
  port: "customer.mailer",
  recipient: "Mailchimp",
  kind: "processor",
  country: "US",
  safeguard: "standard-contractual-clauses",
  status: "disclosed",
  category: null,
  persons: 1,
  ...overrides,
});

const byCount = (a: ForgottenRecipient, b: ForgottenRecipient): number => {
  const key = (row: ForgottenRecipient) =>
    JSON.stringify([
      row.port,
      row.recipient,
      row.kind,
      row.country,
      row.safeguard ?? "",
      row.status,
      row.category ?? "",
    ]);
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
};

const forgottenOf = async (storage: Pick<Storage, "recipients">) =>
  [...(await storage.recipients.forgottenCounts())].sort(byCount);

/**
 * The behaviour every recipient store must exhibit. Call it inside a `describe` of the adapter's
 * test file with a factory that returns a fresh, empty storage.
 */
export const recipientStoreContract: RecipientStoreContractFunction = ({ create }) => {
  describe("recipient store contract", () => {
    let storage: Pick<Storage, "recipients" | "transact">;

    beforeEach(async () => {
      storage = await create();
    });

    it("knows no disclosure of a person never disclosed, nor any declared port", async () => {
      expect(await storage.recipients.disclosures("c-1")).toEqual([]);
      expect(await storage.recipients.declared()).toEqual([]);
      expect(await storage.recipients.summary()).toEqual([]);
      expect(await storage.recipients.forgottenCounts()).toEqual([]);
    });

    it("sums the forgotten persons of each identity, status and category, a safeguard or category of none apart from any", async () => {
      const rows = [
        counted(),
        counted({ category: "contact" }),
        counted({ category: "contact", persons: 2 }),
        counted({ status: "presumed" }),
        counted({ safeguard: null, country: "FR" }),
        counted({ safeguard: null }),
        counted({ safeguard: "adequacy" }),
        counted({ kind: "joint-controller" }),
        counted({ recipient: "Brevo" }),
        counted({ port: "order.mailer", category: "invoices", persons: 4 }),
      ];
      await storage.recipients.countForgotten(rows);
      await storage.recipients.countForgotten([counted({ persons: 3 })]);
      await storage.recipients.countForgotten([]);
      expect(await forgottenOf(storage)).toEqual(
        [
          counted({ persons: 4 }),
          counted({ category: "contact", persons: 3 }),
          counted({ status: "presumed" }),
          counted({ safeguard: null, country: "FR" }),
          counted({ safeguard: null }),
          counted({ safeguard: "adequacy" }),
          counted({ kind: "joint-controller" }),
          counted({ recipient: "Brevo" }),
          counted({ port: "order.mailer", category: "invoices", persons: 4 }),
        ].sort(byCount),
      );
    });

    it("keeps the forgotten persons apart from the disclosures, which a forgetting does not touch", async () => {
      await storage.recipients.disclose([disclosure()], at(1));
      await storage.recipients.countForgotten([counted()]);
      await storage.recipients.forget("c-1", null);
      expect(await storage.recipients.forgottenCounts()).toEqual([counted()]);
      expect(await storage.recipients.summary()).toEqual([]);
      expect(await storage.recipients.received()).toEqual(new Map());
    });

    it("records a disclosure once, answering it as new the first time only", async () => {
      expect(await storage.recipients.disclose([disclosure()], at(1))).toEqual([disclosure()]);
      expect(await storage.recipients.disclose([disclosure()], at(3))).toEqual([]);
      expect(await storage.recipients.disclosures("c-1")).toEqual([
        { ...disclosure(), firstAt: at(1), lastAt: at(3) },
      ]);
    });

    it("never moves the last disclosure back", async () => {
      await storage.recipients.disclose([disclosure()], at(3));
      await storage.recipients.disclose([disclosure()], at(1));
      expect(await storage.recipients.disclosures("c-1")).toEqual([
        { ...disclosure(), firstAt: at(3), lastAt: at(3) },
      ]);
    });

    it("keeps a disclosure apart by port, recipient and category, and a person's to them", async () => {
      const rows = [
        disclosure({ port: "order.mailer", person: "c-9" }),
        disclosure({ category: "profile" }),
        disclosure({ recipient: "Brevo", country: "FR", safeguard: null }),
        disclosure({ port: "order.mailer" }),
        disclosure(),
        disclosure({ person: "c-2" }),
      ];
      expect(await storage.recipients.disclose(rows, at(1))).toEqual(rows);
      expect(await storage.recipients.disclosures("c-1")).toEqual(
        [
          disclosure({ recipient: "Brevo", country: "FR", safeguard: null }),
          disclosure(),
          disclosure({ category: "profile" }),
          disclosure({ port: "order.mailer" }),
        ].map((row) => ({ ...row, firstAt: at(1), lastAt: at(1) })),
      );
      expect(await storage.recipients.summary()).toEqual([
        { port: "customer.mailer", persons: 2 },
        { port: "order.mailer", persons: 2 },
      ]);
    });

    it("lists the disclosures of several persons at once, as disclosures does for each, past what a statement binds", async () => {
      const many = Array.from({ length: 205 }, (_, index) => `m-${index}`);
      const rows = [
        disclosure({ port: "order.mailer" }),
        disclosure(),
        disclosure({ person: "c-2", category: "profile" }),
        ...many.map((person) => disclosure({ person })),
      ];
      await storage.recipients.disclose(rows, at(1));
      const listed = await storage.recipients.disclosuresOfMany([
        "c-1",
        "c-2",
        "c-3",
        "c-1",
        ...many,
      ]);
      expect([...listed.keys()].sort()).toEqual(["c-1", "c-2", ...many].sort());
      for (const person of ["c-1", "c-2", "m-0", "m-204"]) {
        expect(listed.get(person)).toEqual(await storage.recipients.disclosures(person));
      }
      expect(listed.get("c-1")).toHaveLength(2);
      expect(await storage.recipients.disclosuresOfMany([])).toEqual(new Map());
    });

    it("forgets a person's disclosures of the categories named, or all of them", async () => {
      await storage.recipients.disclose(
        [
          disclosure(),
          disclosure({ category: "profile" }),
          disclosure({ category: "invoices" }),
          disclosure({ person: "c-2" }),
        ],
        at(1),
      );
      await storage.recipients.forget("c-1", ["contact", "invoices"]);
      expect((await storage.recipients.disclosures("c-1")).map(({ category }) => category)).toEqual(
        ["profile"],
      );
      await storage.recipients.forget("c-1", null);
      expect(await storage.recipients.disclosures("c-1")).toEqual([]);
      expect(await storage.recipients.disclosures("c-2")).toHaveLength(1);
    });

    it("declares a port once, at the position it was first seen, with its categories as now", async () => {
      expect(
        await storage.recipients.declare(
          [
            { port: "order.mailer", categories: ["contact"] },
            { port: "customer.crm", categories: ["profile", "contact"] },
          ],
          4,
          at(1),
        ),
      ).toEqual([
        {
          port: "customer.crm",
          categories: ["profile", "contact"],
          presumedThrough: 4,
          caughtUpThrough: 0,
          declaredAt: at(1),
        },
        {
          port: "order.mailer",
          categories: ["contact"],
          presumedThrough: 4,
          caughtUpThrough: 0,
          declaredAt: at(1),
        },
      ]);
      expect(
        await storage.recipients.declare(
          [
            { port: "order.mailer", categories: ["invoices"] },
            { port: "customer.ads", categories: ["marketing"] },
          ],
          9,
          at(2),
        ),
      ).toEqual([
        {
          port: "customer.ads",
          categories: ["marketing"],
          presumedThrough: 9,
          caughtUpThrough: 0,
          declaredAt: at(2),
        },
        {
          port: "customer.crm",
          categories: ["profile", "contact"],
          presumedThrough: 4,
          caughtUpThrough: 0,
          declaredAt: at(1),
        },
        {
          port: "order.mailer",
          categories: ["invoices"],
          presumedThrough: 4,
          caughtUpThrough: 0,
          declaredAt: at(1),
        },
      ]);
      expect(await storage.recipients.declared()).toHaveLength(3);
    });

    it("presumes every port through a position, never moving one back", async () => {
      await storage.recipients.declare(
        [{ port: "customer.crm", categories: ["contact"] }],
        4,
        at(1),
      );
      await storage.recipients.declare(
        [{ port: "customer.ads", categories: ["contact"] }],
        12,
        at(2),
      );
      await storage.recipients.presumeThrough(8);
      expect(await storage.recipients.declared()).toEqual([
        {
          port: "customer.ads",
          categories: ["contact"],
          presumedThrough: 12,
          caughtUpThrough: 0,
          declaredAt: at(2),
        },
        {
          port: "customer.crm",
          categories: ["contact"],
          presumedThrough: 8,
          caughtUpThrough: 0,
          declaredAt: at(1),
        },
      ]);
    });

    it("moves what a port held under its former key, keeping one disclosure from its first time to its last", async () => {
      await storage.recipients.disclose([disclosure({ port: "customer.newsletter" })], at(1));
      await storage.recipients.disclose([disclosure({ port: "customer.newsletter" })], at(2));
      await storage.recipients.disclose([disclosure(), disclosure({ category: "profile" })], at(3));
      await storage.recipients.disclose([disclosure()], at(5));
      await storage.recipients.disclose(
        [disclosure({ port: "customer.newsletter", category: "invoices" })],
        at(3),
      );
      await storage.recipients.disclose(
        [disclosure({ port: "customer.newsletter", category: "invoices" })],
        at(5),
      );
      await storage.recipients.disclose([disclosure({ category: "invoices" })], at(1));
      await storage.recipients.disclose([disclosure({ category: "invoices" })], at(2));
      await storage.recipients.disclose([disclosure({ port: "customer.crm" })], at(4));
      await storage.recipients.declare(
        [{ port: "customer.mailer", categories: ["contact"] }],
        7,
        at(1),
      );
      await storage.recipients.caughtUp("customer.mailer", 6);
      await storage.recipients.declare(
        [{ port: "customer.newsletter", categories: ["contact", "profile"] }],
        2,
        at(2),
      );
      await storage.recipients.rename("customer.mailer", "customer.newsletter");
      expect(await storage.recipients.disclosures("c-1")).toEqual([
        { ...disclosure({ port: "customer.crm" }), firstAt: at(4), lastAt: at(4) },
        { ...disclosure({ port: "customer.newsletter" }), firstAt: at(1), lastAt: at(5) },
        {
          ...disclosure({ port: "customer.newsletter", category: "invoices" }),
          firstAt: at(1),
          lastAt: at(5),
        },
        {
          ...disclosure({ port: "customer.newsletter", category: "profile" }),
          firstAt: at(3),
          lastAt: at(3),
        },
      ]);
      expect(await storage.recipients.declared()).toEqual([
        {
          port: "customer.newsletter",
          categories: ["contact", "profile"],
          presumedThrough: 7,
          caughtUpThrough: 6,
          declaredAt: at(2),
        },
      ]);
      await storage.recipients.rename("customer.newsletter", "customer.mail");
      expect(await storage.recipients.declared()).toEqual([
        {
          port: "customer.mail",
          categories: ["contact", "profile"],
          presumedThrough: 7,
          caughtUpThrough: 6,
          declaredAt: at(2),
        },
      ]);
      await storage.recipients.rename("customer.gone", "customer.mail");
      expect(await storage.recipients.disclosures("c-1")).toHaveLength(4);
    });

    it("moves the forgotten persons a port held under its former key, summing those held under both", async () => {
      await storage.recipients.countForgotten([
        counted({ port: "customer.newsletter", persons: 2 }),
        counted({ port: "customer.newsletter", category: "contact" }),
        counted({ port: "customer.newsletter", safeguard: null, category: "profile" }),
        counted(),
        counted({ category: "contact", persons: 5 }),
        counted({ port: "customer.crm" }),
      ]);
      await storage.recipients.rename("customer.newsletter", "customer.mailer");
      expect(await forgottenOf(storage)).toEqual(
        [
          counted({ port: "customer.crm" }),
          counted({ persons: 3 }),
          counted({ category: "contact", persons: 6 }),
          counted({ safeguard: null, category: "profile" }),
        ].sort(byCount),
      );
      await storage.recipients.rename("customer.gone", "customer.mailer");
      expect(await storage.recipients.forgottenCounts()).toHaveLength(4);
    });

    it("moves how far a port was caught up forward, never back", async () => {
      await storage.recipients.declare(
        [{ port: "customer.crm", categories: ["contact"] }],
        9,
        at(1),
      );
      await storage.recipients.caughtUp("customer.crm", 5);
      await storage.recipients.caughtUp("customer.crm", 3);
      await storage.recipients.caughtUp("customer.gone", 3);
      expect(await storage.recipients.declared()).toEqual([
        {
          port: "customer.crm",
          categories: ["contact"],
          presumedThrough: 9,
          caughtUpThrough: 5,
          declaredAt: at(1),
        },
      ]);
    });

    it("keeps nothing a transaction that fails wrote, and what one that commits wrote", async () => {
      await expect(
        storage.transact(async (transaction) => {
          await transaction.recipients.disclose([disclosure()], at(1));
          await transaction.recipients.declare(
            [{ port: "customer.mailer", categories: ["contact"] }],
            2,
            at(1),
          );
          await transaction.recipients.countForgotten([counted()]);
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");
      expect(await storage.recipients.disclosures("c-1")).toEqual([]);
      expect(await storage.recipients.declared()).toEqual([]);
      expect(await storage.recipients.forgottenCounts()).toEqual([]);
      await storage.transact(async (transaction) => {
        expect(await transaction.recipients.disclose([disclosure()], at(1))).toEqual([
          disclosure(),
        ]);
        await transaction.recipients.forget("c-2", null);
        await transaction.recipients.countForgotten([counted()]);
        expect(await transaction.recipients.forgottenCounts()).toEqual([counted()]);
      });
      expect(await storage.recipients.disclosures("c-1")).toHaveLength(1);
      expect(await storage.recipients.forgottenCounts()).toEqual([counted()]);
    });
  });
};
