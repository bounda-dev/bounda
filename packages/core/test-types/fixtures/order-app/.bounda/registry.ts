import type { Registry } from "@bounda-dev/core";
import * as registerCustomer from "../app/domain/customer/commands/register-customer.ts";
import * as customerRegistered from "../app/domain/customer/customer-registered.ts";
import * as customerState from "../app/domain/customer/state.ts";
import auditLogMemory from "../app/domain/order/commands/cancel-order/audit-log.memory.ts";
import * as cancelOrder from "../app/domain/order/commands/cancel-order/index.ts";
import * as payOrder from "../app/domain/order/commands/pay-order.ts";
import * as placeOrder from "../app/domain/order/commands/place-order/index.ts";
import inventoryFake from "../app/domain/order/commands/place-order/inventory.fake.ts";
import * as orderCancelled from "../app/domain/order/order-cancelled.ts";
import * as orderPaid from "../app/domain/order/order-paid.ts";
import * as orderPlaced from "../app/domain/order/order-placed.ts";
import * as orderPlacedUpcasts from "../app/domain/order/order-placed.upcast.ts";
import * as sendReceiptOnOrderPaid from "../app/domain/order/policies/send-receipt-on-order-paid.ts";
import * as orderPayment from "../app/domain/order/processes/order-payment/index.ts";
import * as orderPaymentOnOrderPaid from "../app/domain/order/processes/order-payment/on-order-paid.ts";
import * as orderPaymentOnTimeout from "../app/domain/order/processes/order-payment/on-timeout.ts";
import * as orderState from "../app/domain/order/state.ts";
import * as orderSummaryOnOrderPaid from "../app/read/order-summary/projections/order-paid.ts";
import * as orderSummaryOnOrderPlaced from "../app/read/order-summary/projections/order-placed.ts";
import * as customerOverview from "../app/read/order-summary/queries/customer-overview.ts";
import * as getOrder from "../app/read/order-summary/queries/get-order.ts";
import * as listUnpaidOrders from "../app/read/order-summary/queries/list-unpaid-orders.ts";
import * as orderSummaryView from "../app/read/order-summary/view.ts";

export const registry = {
  aggregates: {
    customer: {
      state: customerState,
      events: { customerRegistered },
      commands: { registerCustomer: { module: registerCustomer } },
      policies: {},
      processes: {},
    },
    order: {
      state: orderState,
      events: { orderCancelled, orderPaid, orderPlaced },
      upcasts: { orderPlaced: orderPlacedUpcasts },
      commands: {
        cancelOrder: {
          module: cancelOrder,
          collaborators: { auditLog: { memory: auditLogMemory } },
        },
        payOrder: { module: payOrder },
        placeOrder: {
          module: placeOrder,
          collaborators: { inventory: { fake: inventoryFake } },
        },
      },
      policies: { sendReceiptOnOrderPaid },
      processes: {
        orderPayment: {
          module: orderPayment,
          handlers: { orderPaid: orderPaymentOnOrderPaid },
          timeout: orderPaymentOnTimeout,
        },
      },
    },
  },
  readModels: {
    orderSummary: {
      view: orderSummaryView,
      projections: { orderPaid: orderSummaryOnOrderPaid, orderPlaced: orderSummaryOnOrderPlaced },
      queries: { customerOverview, getOrder, listUnpaidOrders },
    },
  },
} as const satisfies Registry;
