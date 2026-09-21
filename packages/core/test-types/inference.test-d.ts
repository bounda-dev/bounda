import type {
  CommandsFacade,
  DispatchOptions,
  DispatchResult,
  QueriesFacade,
  StoredEvent,
  Table,
} from "@bounda-dev/core";
import { describe, expectTypeOf, it } from "vitest";
import type { registry } from "./fixtures/order-app/.bounda/registry.ts";
import type { Commands, Queries } from "./fixtures/order-app/.bounda/types.ts";
import type { Event as CustomerRegistered } from "./fixtures/order-app/app/domain/customer/+types/customer-registered.ts";
import type { Event as OrderPlaced } from "./fixtures/order-app/app/domain/order/+types/order-placed.ts";
import type { Command as PayOrder } from "./fixtures/order-app/app/domain/order/commands/+types/pay-order.ts";
import type { Command as CancelOrder } from "./fixtures/order-app/app/domain/order/commands/cancel-order/+types/index.ts";
import type { Command as PlaceOrder } from "./fixtures/order-app/app/domain/order/commands/place-order/+types/index.ts";
import type { Policy as SendReceipt } from "./fixtures/order-app/app/domain/order/policies/+types/send-receipt-on-order-paid.ts";
import type { Process as OrderPayment } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/index.ts";
import type { Process as OnOrderPaid } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/on-order-paid.ts";
import type { Process as OnTimeout } from "./fixtures/order-app/app/domain/order/processes/order-payment/+types/on-timeout.ts";
import type { Projection as ProjectOrderPaid } from "./fixtures/order-app/app/read/order-summary/projections/+types/order-paid.ts";
import type { Query as CustomerOverview } from "./fixtures/order-app/app/read/order-summary/queries/+types/customer-overview.ts";
import type { Query as GetOrder } from "./fixtures/order-app/app/read/order-summary/queries/+types/get-order.ts";
import type { Query as ListUnpaidOrders } from "./fixtures/order-app/app/read/order-summary/queries/+types/list-unpaid-orders.ts";

type Registry = typeof registry;
type OrderStatus = "new" | "placed" | "paid" | "cancelled";

interface OrderSummaryRow {
  readonly orderId: string;
  readonly customerId: string;
  readonly status: string;
  readonly total: number;
  readonly paidAt?: Date;
}

describe("payload inference", () => {
  it("keeps enums and nested arrays exact", () => {
    expectTypeOf<PayOrder.HandlerArgs["command"]["payload"]["method"]>().toEqualTypeOf<
      "card" | "transfer"
    >();
    expectTypeOf<PlaceOrder.HandlerArgs["command"]["payload"]["lines"][number]>().toEqualTypeOf<{
      sku: string;
      quantity: number;
      unitPrice: number;
    }>();
  });

  it("types the command itself", () => {
    expectTypeOf<PlaceOrder.HandlerArgs["command"]["type"]>().toEqualTypeOf<"PlaceOrder">();
    expectTypeOf<PlaceOrder.HandlerArgs["command"]["aggregateId"]>().toEqualTypeOf<string>();
  });
});

describe("state inference", () => {
  it("comes from state.ts with its declared unions plus identity and version", () => {
    expectTypeOf<PlaceOrder.HandlerArgs["state"]["status"]>().toEqualTypeOf<OrderStatus>();
    expectTypeOf<PlaceOrder.HandlerArgs["state"]["total"]>().toEqualTypeOf<number>();
    expectTypeOf<PlaceOrder.HandlerArgs["state"]["id"]>().toEqualTypeOf<string>();
    expectTypeOf<PlaceOrder.HandlerArgs["state"]["version"]>().toEqualTypeOf<number>();
  });

  it("reaches apply as well", () => {
    expectTypeOf<OrderPlaced.ApplyArgs["state"]["status"]>().toEqualTypeOf<OrderStatus>();
    expectTypeOf<OrderPlaced.ApplyArgs["event"]["payload"]["customerId"]>().toEqualTypeOf<string>();
    expectTypeOf<OrderPlaced.ApplyArgs["event"]["type"]>().toEqualTypeOf<"OrderPlaced">();
    expectTypeOf<CustomerRegistered.ApplyArgs["state"]["active"]>().toEqualTypeOf<boolean>();
  });
});

describe("event builders", () => {
  it("offer only the events of the handler's own aggregate", () => {
    expectTypeOf<keyof PlaceOrder.HandlerArgs["events"]>().toEqualTypeOf<
      "orderPlaced" | "orderPaid" | "orderCancelled"
    >();
    expectTypeOf<PlaceOrder.HandlerArgs["events"]>().not.toHaveProperty("customerRegistered");
  });

  it("take the payload when the event has one and nothing otherwise", () => {
    expectTypeOf<PlaceOrder.HandlerArgs["events"]["orderPaid"]>().parameter(0).toEqualTypeOf<{
      method: "card" | "transfer";
      reference: string;
    }>();
    expectTypeOf<PlaceOrder.HandlerArgs["events"]["orderCancelled"]>().parameters.toEqualTypeOf<
      []
    >();
    expectTypeOf<
      ReturnType<PlaceOrder.HandlerArgs["events"]["orderCancelled"]>["type"]
    >().toEqualTypeOf<"OrderCancelled">();
  });
});

describe("collaborators", () => {
  it("come from the declared Collaborators type when present", () => {
    expectTypeOf<PlaceOrder.HandlerArgs["inventory"]["reserve"]>().toEqualTypeOf<
      (skus: readonly string[]) => Promise<void>
    >();
  });

  it("are inferred from the implementations otherwise", () => {
    expectTypeOf<CancelOrder.HandlerArgs["auditLog"]["record"]>().toEqualTypeOf<
      (entry: string) => void
    >();
  });

  it("are absent when the command has none", () => {
    expectTypeOf<PayOrder.HandlerArgs>().not.toHaveProperty("inventory");
  });
});

describe("policies", () => {
  it("receive the stored event of the file name and the full commands facade", () => {
    expectTypeOf<SendReceipt.HandlerArgs["event"]>().toEqualTypeOf<
      StoredEvent<"OrderPaid", { method: "card" | "transfer"; reference: string }>
    >();
    expectTypeOf<SendReceipt.HandlerArgs["commands"]>().toHaveProperty("payOrder");
    expectTypeOf<SendReceipt.HandlerArgs["commands"]>().toHaveProperty("registerCustomer");
  });
});

describe("processes", () => {
  it("expose the aggregate's event names as literals in config", () => {
    expectTypeOf<keyof OrderPayment.ConfigArgs["events"]>().toEqualTypeOf<
      "OrderPlaced" | "OrderPaid" | "OrderCancelled"
    >();
    expectTypeOf<OrderPayment.ConfigArgs["events"]["OrderPaid"]>().toEqualTypeOf<"OrderPaid">();
    expectTypeOf<OrderPayment.ConfigArgs["events"]>().not.toHaveProperty("OrderPlacd");
  });

  it("type state from the state schema and the event from the file name", () => {
    expectTypeOf<OnOrderPaid.HandlerArgs["state"]["reminders"]>().toEqualTypeOf<number>();
    expectTypeOf<
      OnOrderPaid.HandlerArgs["event"]["payload"]["reference"]
    >().toEqualTypeOf<string>();
    expectTypeOf<OnTimeout.TimeoutArgs["state"]["reminders"]>().toEqualTypeOf<number>();
    expectTypeOf<OnTimeout.TimeoutArgs["aggregateId"]>().toEqualTypeOf<string>();
    expectTypeOf<OnTimeout.TimeoutArgs>().not.toHaveProperty("event");
  });
});

describe("read models", () => {
  it("derive the row type from fields, with optional columns optional", () => {
    expectTypeOf<ProjectOrderPaid.Args["table"]>().toEqualTypeOf<Table<OrderSummaryRow>>();
    expectTypeOf<ProjectOrderPaid.Args["event"]["type"]>().toEqualTypeOf<"OrderPaid">();
  });

  it("type repositoryData from what repository returns", () => {
    expectTypeOf<GetOrder.HandlerArgs["repositoryData"]>().toEqualTypeOf<OrderSummaryRow | null>();
    expectTypeOf<ListUnpaidOrders.HandlerArgs["repositoryData"]>().toEqualTypeOf<
      readonly OrderSummaryRow[]
    >();
    expectTypeOf<GetOrder.RepositoryArgs["orderId"]>().toEqualTypeOf<string>();
  });

  it("let a query compose other queries through the typed facade", () => {
    expectTypeOf<CustomerOverview.HandlerArgs["queries"]>().toHaveProperty("getOrder");
    expectTypeOf<Queries["customerOverview"]>().returns.toEqualTypeOf<
      Promise<{ unpaidCount: number; outstanding: number; lastStatus: string | null }>
    >();
  });
});

describe("facades", () => {
  it("expose every command with its payload and dispatch options", () => {
    expectTypeOf<Commands>().toHaveProperty("placeOrder");
    expectTypeOf<Commands>().toHaveProperty("registerCustomer");
    expectTypeOf<Commands["payOrder"]>().parameter(0).toEqualTypeOf<{
      orderId: string;
      method: "card" | "transfer";
      reference: string;
    }>();
    expectTypeOf<Commands["payOrder"]>().parameter(1).toEqualTypeOf<DispatchOptions | undefined>();
    expectTypeOf<Commands["payOrder"]>().returns.toEqualTypeOf<Promise<DispatchResult>>();
  });

  it("match the facades derived from the runtime registry", () => {
    expectTypeOf<CommandsFacade<Registry>>().toEqualTypeOf<Commands>();
    expectTypeOf<QueriesFacade<Registry>>().toEqualTypeOf<Queries>();
  });

  it("expose every query with the result type its handler returns", () => {
    expectTypeOf<Queries["getOrder"]>().returns.toEqualTypeOf<Promise<OrderSummaryRow | null>>();
    expectTypeOf<Queries["listUnpaidOrders"]>().returns.toEqualTypeOf<
      Promise<{ orders: readonly OrderSummaryRow[]; outstanding: number }>
    >();
    expectTypeOf<Queries["listUnpaidOrders"]>()
      .parameter(0)
      .toEqualTypeOf<{ customerId: string; limit?: number | undefined }>();
  });

  it("apply defaults before the repository and the handler see the payload", () => {
    expectTypeOf<ListUnpaidOrders.RepositoryArgs["limit"]>().toEqualTypeOf<number>();
    expectTypeOf<
      ListUnpaidOrders.HandlerArgs["query"]["payload"]["limit"]
    >().toEqualTypeOf<number>();
  });
});
