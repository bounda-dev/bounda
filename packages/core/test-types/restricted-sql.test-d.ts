import { describe, expectTypeOf, it } from "vitest";
import type { OrderSummaryRow } from "./fixtures/order-app/.bounda/types.ts";
import type { Projection } from "./fixtures/order-app/app/read/order-summary/projections/order/+types/order-placed.ts";
import type { Query as GetOrder } from "./fixtures/order-app/app/read/order-summary/queries/+types/get-order.ts";
import type { Query as ListUnpaidOrders } from "./fixtures/order-app/app/read/order-summary/queries/+types/list-unpaid-orders.ts";
import type * as getOrder from "./fixtures/order-app/app/read/order-summary/queries/get-order.ts";
import type * as listUnpaidOrders from "./fixtures/order-app/app/read/order-summary/queries/list-unpaid-orders.ts";

describe("the condition hand-written SQL leaves restricted rows out with", () => {
  it("is plain SQL text, of the table or of the alias the statement gives it, in a query and in a projection", () => {
    type Unrestricted = GetOrder.RepositoryArgs["client"]["unrestricted"];
    expectTypeOf<Unrestricted>().toEqualTypeOf<(alias?: string) => string>();
    expectTypeOf<ListUnpaidOrders.RepositoryArgs["client"]["unrestricted"]>().toEqualTypeOf<
      (alias?: string) => string
    >();
    expectTypeOf<Projection.Args["client"]["unrestricted"]>().toEqualTypeOf<
      (alias?: string) => string
    >();
  });

  it("goes into a statement whose rows keep the view's types", () => {
    expectTypeOf<ReturnType<typeof getOrder.repository>>().toEqualTypeOf<
      Promise<OrderSummaryRow | null>
    >();
    expectTypeOf<ReturnType<typeof listUnpaidOrders.repository>>().toEqualTypeOf<
      Promise<readonly OrderSummaryRow[]>
    >();
  });
});
