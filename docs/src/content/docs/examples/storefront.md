---
title: The storefront example
description: A small shop that uses every kind of module, in the repository under examples/storefront.
sidebar:
  order: 0
---

`examples/storefront` in the repository is a complete app on Node and SQLite. It is small enough
to read in one sitting and touches everything Bounda does.

```bash
git clone https://github.com/bounda-dev/bounda
cd bounda && pnpm install && pnpm build && pnpm generate
cd examples/storefront
pnpm test
pnpm start
```

## What happens when an order is placed

The customer pays through a payment link, in the style of Stripe: the app creates a payment intent,
the customer pays it whenever they like, and the provider tells the app how it went through
webhooks.

1. `placeOrder` validates the items, computes the total and appends `OrderPlaced`.
2. The policy `send-confirmation-on-order-placed` sends the confirmation through the order's
   `notifier` port, then dispatches `recordConfirmationSent`, which appends
   `ConfirmationSent`. `bounda.config.ts` picks the `console` implementation for the demo, and
   each test passes its own double, which records what was sent.
3. The policy `schedule-reminder-on-order-placed` dispatches `sendReminder` with a delay of a
   day. The reminder is a scheduled command; when it runs, the handler appends `ReminderSent`
   only if the order is still `placed`.
4. The process `order-lifecycle` starts and dispatches `requestPayment`, whose handler creates
   the intent through the `payment` aggregate's `gateway` port. The process gives the
   customer 72 hours to pay, as a deadline in its state.
5. The provider's webhooks are commands on the payment: `markPaymentProcessing`,
   `settlePayment` and `declinePayment`. The process follows the payment's events, which carry
   the order's id as `orderId`, so they reach its instance with no `correlate`:
   `PaymentProcessing` locks the order (`paying`, which refuses a cancellation), `PaymentSettled`
   marks it paid and `PaymentDeclined` cancels it.
6. Once the order is paid the process dispatches `fulfillOrder`. When the order is cancelled,
   whoever cancelled it, the process cancels the payment, and a payment that settles after it was
   cancelled is refunded by the policy `refund-on-refund-requested`.
7. Two read models follow along: `order-summary`, with a query written in SQL and the payment's
   status, and `my-orders`.

[Sagas and compensation](/guides/sagas/) walks through this flow step by step: what each step
compensates, and what happens when the webhooks arrive late, twice or out of order.

Neither aggregate has a `state.ts`: their state is inferred from what their events return.
`order-placed.ts` and `payment-requested.ts` open their aggregates with `begin`, so a handler
that has checked `state.status` reads `state.customerId` or `state.intentId` as a string, and
`state.status === undefined` means the order or the payment does not exist yet.

## Things worth copying

**An effect after the commit.** The confirmation goes out from a policy, once `OrderPlaced` is
stored, not from the command that places the order: a command handler can run again on a
concurrency conflict, and it runs before anything is decided. The policy hands the notifier its
`idempotencyKey`, the same on every retry, and reports back with a command whose handler ignores a
second report:

```ts
// policies/send-confirmation-on-order-placed.ts
export const handler = async ({ event, commands, notifier, idempotencyKey }: Policy.HandlerArgs) => {
  await notifier({
    orderId: event.aggregateId,
    customerId: event.payload.customerId,
    total: event.payload.total,
    idempotencyKey,
  });
  await commands.recordConfirmationSent({ orderId: event.aggregateId });
};
```

**A port with two implementations.** `order/notifier.ts` declares the contract, a callable
`Notifier` that takes `NotifierArgs`; `console.ts` and `memory.ts` in
`order/infrastructure/notifier/` implement it. The config decides,
and only one of the two names compiles:

```ts
export default defineConfig({
  storage: sqlite({ path: process.env.STOREFRONT_DB ?? "./data/storefront.db" }),
  ports: {
    order: { notifier: process.env.NOTIFIER === "memory" ? "memory" : "console" },
  },
});
```

**A delay from the environment.** A duration typed by the compiler is a literal such as `"24h"`;
one that comes from an environment variable is a string. `asDuration` checks it where it is used:

```ts
await commands.sendReminder(
  { orderId: event.aggregateId },
  { delay: asDuration(process.env.REMINDER_DELAY ?? "24h") },
);
```

**Time in tests.** The clock of `createTestApp` moves only when told to, so a reminder a day away
and a payment window three days away are two lines:

```ts
clock.advance(24 * HOUR);
await app.runUntilIdle();
```

**A query in SQL.** `list-orders-by-customer.ts` reads the table directly through `client` and
still gets rows typed from the view's fields:

```ts
export const repository = ({ client, customerId }: Query.RepositoryArgs) =>
  client.all(
    "SELECT * FROM bounda_rm_order_summary WHERE customer_id = ? ORDER BY placed_at, order_id",
    [customerId],
  );
```

**Booting from the generated registry.** `tests/boot.test.ts` starts the app twice on the same
SQLite file through `boot()` and reads back what the first run wrote.
