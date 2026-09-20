import type { Registry } from "@bounda-dev/core";
import * as payOrder from "../app/domain/order/commands/pay-order.ts";
import * as placeOrder from "../app/domain/order/commands/place-order.ts";
import * as orderCancelled from "../app/domain/order/order-cancelled.ts";
import * as orderPaid from "../app/domain/order/order-paid.ts";
import * as orderPlaced from "../app/domain/order/order-placed.ts";

export const registry = {
  aggregates: {
    order: {
      events: { orderCancelled, orderPaid, orderPlaced },
      commands: { payOrder: { module: payOrder }, placeOrder: { module: placeOrder } },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as const satisfies Registry;
