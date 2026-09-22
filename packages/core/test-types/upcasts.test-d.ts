import type { Upcasts } from "@bounda-dev/core";
import { describe, expectTypeOf, it } from "vitest";
import type { Event as OrderPlaced } from "./fixtures/order-app/app/domain/order/+types/order-placed.ts";
import { upcasts } from "./fixtures/order-app/app/domain/order/order-placed.upcast.ts";

interface PayloadV1 {
  readonly customerId: string;
  readonly lines: readonly {
    readonly sku: string;
    readonly quantity: number;
    readonly price: number;
  }[];
}

describe("Event.Upcasts", () => {
  it("accepts a chain whose last step returns the current payload", () => {
    expectTypeOf(upcasts).toMatchTypeOf<OrderPlaced.Upcasts>();
    const two = [
      (payload: { readonly total: number }) => ({ customerId: "", total: payload.total }),
      (payload: { readonly customerId: string; readonly total: number }) => ({
        customerId: payload.customerId,
        lines: [{ sku: "x", quantity: 1, unitPrice: payload.total }],
      }),
    ] satisfies OrderPlaced.Upcasts;
    void two;
  });

  it("refuses a last step that does not produce the current payload, and an empty chain", () => {
    const dropsLines = (payload: PayloadV1) => ({ customerId: payload.customerId });
    // @ts-expect-error the last upcast must return today's payload
    const wrong = [dropsLines] satisfies OrderPlaced.Upcasts;
    void wrong;
    // @ts-expect-error at least one upcast; an event that never changed has no upcast module
    const none = [] satisfies OrderPlaced.Upcasts;
    void none;
    const notAFunction = { total: 1 };
    // @ts-expect-error every step is a function of the previous payload
    const objects = [notAFunction] satisfies OrderPlaced.Upcasts;
    void objects;
  });

  it("is the generic the +types file specialises", () => {
    expectTypeOf<OrderPlaced.Upcasts>().toEqualTypeOf<
      Upcasts<OrderPlaced.ApplyArgs["event"]["payload"]>
    >();
  });
});
