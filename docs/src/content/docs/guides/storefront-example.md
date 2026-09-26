---
title: The storefront example
description: A small shop that uses every kind of module, in the repository under examples/storefront.
sidebar:
  order: 1
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

1. `placeOrder` validates the items, computes the total and appends `OrderPlaced`.
2. The policy `send-confirmation-on-order-placed` sends the confirmation through its `notifier`
   collaborator, then dispatches `recordConfirmationSent`, which appends `ConfirmationSent`.
   `bounda.config.ts` picks `notifier.console` for the demo and the tests pick
   `notifier.memory`, which records what was sent.
3. The policy `schedule-reminder-on-order-placed` dispatches `sendReminder` with a delay of a
   day. The reminder is a scheduled command; when it runs, the handler appends `ReminderSent`
   only if the order is still `placed`.
4. The process `order-lifecycle` starts. When the order is confirmed it dispatches
   `fulfillOrder`; if nothing completes it within 72 hours, its time-out handler cancels the
   order.
5. Two read models follow along: `order-summary`, with a query written in SQL, and `my-orders`.

The aggregate has no `state.ts`. Its state is inferred from the `apply` functions, so
`state.status` is `"placed" | "confirmed" | "fulfilled" | "cancelled" | undefined` in every
handler.

## Things worth copying

**An effect after the commit.** The confirmation goes out from a policy, once `OrderPlaced` is
stored, not from the command that places the order: a command handler can run again on a
concurrency conflict, and it runs before anything is decided. The policy hands the notifier its
`idempotencyKey`, the same on every retry, and reports back with a command whose handler ignores a
second report:

```ts
// policies/send-confirmation-on-order-placed/index.ts
export const handler = async ({ event, commands, notifier, idempotencyKey }: Policy.HandlerArgs) => {
  await notifier.send(
    { orderId: event.aggregateId, customerId: event.payload.customerId, total: event.payload.total },
    idempotencyKey,
  );
  await commands.recordConfirmationSent({ orderId: event.aggregateId });
};
```

**A collaborator with two implementations.** The policy's `index.ts` declares the contract;
`notifier.console.ts` and `notifier.memory.ts` implement it. The config decides:

```ts
export default defineConfig({
  storage: sqlite({ path: process.env.STOREFRONT_DB ?? "./data/storefront.db" }),
  policies: {
    order: {
      sendConfirmationOnOrderPlaced: { notifier: { use: process.env.NOTIFIER ?? "console" } },
    },
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
and a time-out three days away are two lines:

```ts
clock.advance(24 * HOUR);
await app.processUntilIdle();
```

**A query in SQL.** `list-orders-by-customer.ts` reads the table directly through `client` and
still gets rows typed from the view's fields:

```ts
export const repository = ({ client, customerId }: Query.RepositoryArgs) =>
  client.all(
    "SELECT * FROM bounda_order_summary WHERE customer_id = ? ORDER BY placed_at, order_id",
    [customerId],
  );
```

**Booting from the generated registry.** `tests/boot.test.ts` starts the app twice on the same
SQLite file through `boot()` and reads back what the first run wrote.
