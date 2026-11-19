import { describe, expect, it } from "vitest";
import type { StoredRestriction } from "../../adapter/storage/person-store.ts";
import { ProcessingRestrictedError } from "../../contracts/errors.ts";
import { createDisposableKey, type PersonalKey } from "./crypto.ts";
import { keyedReturned, refuseReturned } from "./returned.ts";

const restricted = (rows: Readonly<Record<string, readonly (string | null)[]>>) => ({
  restrictions: async (person: string) =>
    (rows[person] ?? []).map((category) => ({ category }) as StoredRestriction),
});

describe("refuseReturned", () => {
  const persons = restricted({ ana: ["marketing"], bea: [null], cai: ["contact"] });

  it("refuses a person restricted as a whole or in a category returned, without a basis", async () => {
    await expect(
      refuseReturned({
        persons,
        basis: undefined,
        reads: [{ person: "ana", categories: ["contact"] }],
      }),
    ).resolves.toEqual([]);
    await expect(
      refuseReturned({
        persons,
        basis: undefined,
        reads: [
          { person: "ana", categories: ["contact"] },
          { person: "bea", categories: ["contact"] },
        ],
      }),
    ).rejects.toEqual(new ProcessingRestrictedError("bea"));
    await expect(
      refuseReturned({
        persons,
        basis: undefined,
        reads: [{ person: "cai", categories: ["contact"] }],
      }),
    ).rejects.toEqual(new ProcessingRestrictedError("cai"));
    await expect(
      refuseReturned({
        persons,
        basis: "erasure-exemption",
        reads: [{ person: "cai", categories: ["contact"] }],
      }),
    ).rejects.toBeInstanceOf(ProcessingRestrictedError);
  });

  it("lets them through on a basis of article 18(2), each once", async () => {
    await expect(
      refuseReturned({
        persons,
        basis: "legal-claims",
        reads: [
          { person: "bea", categories: ["contact"] },
          { person: "cai", categories: ["marketing", "contact"] },
          { person: "bea", categories: ["invoices"] },
          { person: "ana", categories: ["contact"] },
        ],
      }),
    ).resolves.toEqual(["bea", "cai"]);
  });
});

describe("keyedReturned", () => {
  it("reads every person's keys at once, and each category under the one in force, created when none is", async () => {
    const [inForce, kept, superseded, created] = await Promise.all([
      createDisposableKey(),
      createDisposableKey(),
      createDisposableKey(),
      createDisposableKey(),
    ]);
    const asked: string[][] = [];
    const made: string[][] = [];
    const keys = {
      heldAllOf: async (persons: readonly string[]) => {
        asked.push([...persons]);
        return new Map([
          [
            "ana",
            [
              { category: "invoices", key: kept, retainedSince: "2026-01-01T00:00:00.000Z" },
              {
                category: "contact",
                key: { ...superseded, successor: "next" },
                retainedSince: null,
              },
              { category: "contact", key: inForce, retainedSince: null },
            ],
          ],
        ]) as never;
      },
      create: async (person: string, category: string): Promise<PersonalKey> => {
        made.push([person, category]);
        return created;
      },
    };
    await expect(
      keyedReturned(keys, [
        { person: "ana", categories: ["contact", "invoices"] },
        { person: "bea", categories: ["contact"] },
        { person: "ana", categories: ["contact"] },
      ]),
    ).resolves.toEqual([
      { person: "ana", fingerprint: inForce.fingerprint },
      { person: "ana", fingerprint: created.fingerprint },
      { person: "bea", fingerprint: created.fingerprint },
      { person: "ana", fingerprint: inForce.fingerprint },
    ]);
    expect(asked).toEqual([["ana", "bea"]]);
    expect(made).toEqual([
      ["ana", "invoices"],
      ["bea", "contact"],
    ]);
  });
});
