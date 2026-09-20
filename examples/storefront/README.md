# Storefront

A small shop on Bounda: one `order` aggregate, a process that fulfils confirmed orders and cancels
the ones nobody fulfils, a reminder scheduled a day after placing, and two read models. Node, SQLite,
no framework.

```bash
pnpm install
pnpm generate        # .bounda/registry.ts, .bounda/types.ts and every +types
pnpm test
pnpm start           # runs a scenario against data/storefront.db and prints the customer's orders
```

`NOTIFIER=memory` swaps the console notifier for the in-memory one the tests use;
`REMINDER_DELAY` and `ORDER_TIMEOUT` accept durations such as `10s` or `2h`.
