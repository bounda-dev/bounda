# Storefront

A small shop on Bounda, paid through a payment link: an `order` aggregate, a `payment` aggregate
that talks to the provider through its `gateway` port, a process that drives the order from
placed to fulfilled and compensates when the payment fails or comes too late, a reminder
scheduled a day after placing, and two read models. Node, SQLite, no framework.

```bash
pnpm install
pnpm generate        # .bounda/registry.ts, .bounda/types.ts and every +types
pnpm test
pnpm start           # runs a scenario against data/storefront.db and prints the customer's orders
```

`pnpm start` places three orders: one paid, one whose payment is declined, and one the customer
cancels and then pays anyway, which is refunded. The provider is a fake (`payment/gateway/fake.ts`)
and its webhooks are commands the script dispatches: `markPaymentProcessing`, `settlePayment` and
`declinePayment`.

`NOTIFIER=memory` swaps the console notifier for the in-memory one. `REMINDER_DELAY`,
`PAYMENT_WINDOW` (how long the customer has to pay, 72 hours) and `ORDER_TIMEOUT` (how long an order
may stay open, 30 days) accept durations such as `10s` or `2h`.
