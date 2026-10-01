import type { ImplementationModule, Registry } from "@bounda-dev/core";
import * as registerCustomer from "../app/domain/customer/commands/register-customer.ts";
import * as customerRegistered from "../app/domain/customer/customer-registered.ts";
import * as customerState from "../app/domain/customer/state.ts";
import type * as orderAuditLog from "../app/domain/order/audit-log/index.ts";
import * as orderAuditLogMemory from "../app/domain/order/audit-log/memory.ts";
import * as cancelOrder from "../app/domain/order/commands/cancel-order.ts";
import * as payOrder from "../app/domain/order/commands/pay-order.ts";
import * as placeOrder from "../app/domain/order/commands/place-order.ts";
import * as orderInventoryFake from "../app/domain/order/inventory/fake.ts";
import type * as orderInventory from "../app/domain/order/inventory/index.ts";
import * as orderInventoryMemory from "../app/domain/order/inventory/memory.ts";
import type * as orderMailer from "../app/domain/order/mailer/index.ts";
import * as orderMailerMemory from "../app/domain/order/mailer/memory.ts";
import * as orderCancelled from "../app/domain/order/order-cancelled.ts";
import * as orderPaid from "../app/domain/order/order-paid.ts";
import * as orderPlaced from "../app/domain/order/order-placed.ts";
import * as orderPlacedUpcasts from "../app/domain/order/order-placed.upcast.ts";
import * as customerGreetOnCustomerRegistered from "../app/domain/order/policies/customer/greet-on-customer-registered.ts";
import * as notifyOnOrderPlaced from "../app/domain/order/policies/notify-on-order-placed.ts";
import * as sendReceiptOnOrderPaid from "../app/domain/order/policies/send-receipt-on-order-paid.ts";
import * as orderPaymentAtNextReminder from "../app/domain/order/processes/order-payment/at-next-reminder.ts";
import * as orderPaymentAtTimeout from "../app/domain/order/processes/order-payment/at-timeout.ts";
import * as orderPaymentOnCustomerCustomerRegistered from "../app/domain/order/processes/order-payment/customer/on-customer-registered.ts";
import * as orderPayment from "../app/domain/order/processes/order-payment/index.ts";
import * as orderPaymentOnOrderPaid from "../app/domain/order/processes/order-payment/on-order-paid.ts";
import * as orderRemindersFake from "../app/domain/order/reminders/fake.ts";
import type * as orderReminders from "../app/domain/order/reminders/index.ts";
import * as orderState from "../app/domain/order/state.ts";
import * as orderSummaryOnOrderOrderPaid from "../app/read/order-summary/projections/order/order-paid.ts";
import * as orderSummaryOnOrderOrderPlaced from "../app/read/order-summary/projections/order/order-placed.ts";
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
      collaborators: {
        auditLog: {
          memory: orderAuditLogMemory satisfies ImplementationModule<orderAuditLog.AuditLog>,
        },
        inventory: {
          fake: orderInventoryFake satisfies ImplementationModule<orderInventory.Inventory>,
          memory: orderInventoryMemory satisfies ImplementationModule<orderInventory.Inventory>,
        },
        mailer: {
          memory: orderMailerMemory satisfies ImplementationModule<orderMailer.Mailer>,
        },
        reminders: {
          fake: orderRemindersFake satisfies ImplementationModule<orderReminders.Reminders>,
        },
      },
      commands: { cancelOrder: { module: cancelOrder }, payOrder: { module: payOrder }, placeOrder: { module: placeOrder } },
      policies: { customerGreetOnCustomerRegistered: { module: customerGreetOnCustomerRegistered, source: "customer" }, notifyOnOrderPlaced: { module: notifyOnOrderPlaced }, sendReceiptOnOrderPaid: { module: sendReceiptOnOrderPaid } },
      processes: {
        orderPayment: {
          module: orderPayment,
          handlers: { order: { orderPaid: orderPaymentOnOrderPaid }, customer: { customerRegistered: orderPaymentOnCustomerCustomerRegistered } },
          deadlines: { nextReminder: orderPaymentAtNextReminder, timeout: orderPaymentAtTimeout },
        },
      },
    },
  },
  readModels: {
    orderSummary: {
      view: orderSummaryView,
      projections: { order: { orderPaid: orderSummaryOnOrderOrderPaid, orderPlaced: orderSummaryOnOrderOrderPlaced } },
      queries: { customerOverview, getOrder, listUnpaidOrders },
    },
  },
} as const satisfies Registry;
