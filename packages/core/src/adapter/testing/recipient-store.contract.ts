import { beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../adapter.ts";
import type { Disclosure } from "../storage/recipient-store.ts";

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
        { port: "order.mailer", persons: 1 },
      ]);
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
          declaredAt: at(1),
        },
        { port: "order.mailer", categories: ["contact"], presumedThrough: 4, declaredAt: at(1) },
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
        { port: "customer.ads", categories: ["marketing"], presumedThrough: 9, declaredAt: at(2) },
        {
          port: "customer.crm",
          categories: ["profile", "contact"],
          presumedThrough: 4,
          declaredAt: at(1),
        },
        { port: "order.mailer", categories: ["invoices"], presumedThrough: 4, declaredAt: at(1) },
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
        { port: "customer.ads", categories: ["contact"], presumedThrough: 12, declaredAt: at(2) },
        { port: "customer.crm", categories: ["contact"], presumedThrough: 8, declaredAt: at(1) },
      ]);
    });

    it("moves what a port held under its former key, keeping one disclosure from its first time to its last", async () => {
      await storage.recipients.disclose([disclosure(), disclosure({ category: "profile" })], at(1));
      await storage.recipients.disclose([disclosure({ port: "customer.newsletter" })], at(3));
      await storage.recipients.declare(
        [{ port: "customer.mailer", categories: ["contact"] }],
        7,
        at(1),
      );
      await storage.recipients.declare(
        [{ port: "customer.newsletter", categories: ["contact", "profile"] }],
        2,
        at(2),
      );
      await storage.recipients.rename("customer.mailer", "customer.newsletter");
      expect(await storage.recipients.disclosures("c-1")).toEqual([
        { ...disclosure({ port: "customer.newsletter" }), firstAt: at(1), lastAt: at(3) },
        {
          ...disclosure({ port: "customer.newsletter", category: "profile" }),
          firstAt: at(1),
          lastAt: at(1),
        },
      ]);
      expect(await storage.recipients.declared()).toEqual([
        {
          port: "customer.newsletter",
          categories: ["contact", "profile"],
          presumedThrough: 7,
          declaredAt: at(2),
        },
      ]);
      await storage.recipients.rename("customer.newsletter", "customer.mail");
      expect(await storage.recipients.declared()).toEqual([
        {
          port: "customer.mail",
          categories: ["contact", "profile"],
          presumedThrough: 7,
          declaredAt: at(2),
        },
      ]);
      await storage.recipients.rename("customer.gone", "customer.mail");
      expect(await storage.recipients.disclosures("c-1")).toHaveLength(2);
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
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");
      expect(await storage.recipients.disclosures("c-1")).toEqual([]);
      expect(await storage.recipients.declared()).toEqual([]);
      await storage.transact(async (transaction) => {
        expect(await transaction.recipients.disclose([disclosure()], at(1))).toEqual([
          disclosure(),
        ]);
        await transaction.recipients.forget("c-2", null);
      });
      expect(await storage.recipients.disclosures("c-1")).toHaveLength(1);
    });
  });
};
