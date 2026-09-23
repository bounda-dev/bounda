import { describe, expect, it } from "vitest";
import type { ReadModelEntry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { digest, fingerprintReadModel, readModelSource } from "./fingerprint.ts";

const fields = ({ f }: FieldsArgs) => ({ orderId: f.string().primaryKey() });
const placed = () => "placed";
const paid = () => "paid";

const entry = (overrides: Partial<ReadModelEntry> = {}): ReadModelEntry => ({
  view: { fields },
  projections: { orderPlaced: { project: placed }, orderPaid: { project: paid, on: "OrderPaid" } },
  queries: {},
  ...overrides,
});

describe("digest", () => {
  it("is FNV-1a from two offset bases, as sixteen hex digits", () => {
    expect(digest("")).toBe("811c9dc5050c5d1f");
    expect(digest("a")).toBe("e40c292c70772d5a");
    expect(digest("ab")).not.toBe(digest("ba"));
  });
});

describe("readModelSource", () => {
  it("lists the fields, then each projection by name with its events and code", () => {
    expect(readModelSource(entry())).toBe(
      [
        String(fields),
        `orderPaid|OrderPaid|${String(paid)}`,
        `orderPlaced||${String(placed)}`,
      ].join("\n"),
    );
  });
});

describe("fingerprintReadModel", () => {
  it("is the digest of the source, whatever the order of the projections", () => {
    expect(fingerprintReadModel(entry())).toBe(digest(readModelSource(entry())));
    expect(
      fingerprintReadModel(
        entry({
          projections: {
            orderPaid: { project: paid, on: "OrderPaid" },
            orderPlaced: { project: placed },
          },
        }),
      ),
    ).toBe(fingerprintReadModel(entry()));
  });
});
