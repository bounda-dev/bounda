# {{name}}

An event-sourced app on [Bounda](https://bounda.dev). One `order` aggregate, one read model, a
test, and the generator that keeps the types in sync with your files.

```bash
{{pm}} install          # also runs bounda generate (prepare)
{{pm}} test
{{pm}} start            # boots the app and places an order
{{pm}} run dev          # regenerates types while you edit
```

## Where things go

```
app/domain/order/           the order aggregate
  order-placed.ts           an event: payload and create, which opens the order
  commands/place-order.ts   a command: payload and handler
app/read/orders/            a read model
  view.ts                   its fields
  projections/order/order-placed.ts   projects the order's OrderPlaced
  queries/list-orders.ts
bounda.config.ts            storage and collaborators
tests/orders.test.ts        the app on an in-memory adapter
```

Add a file, run `{{pm}} run generate`, import its `+types` and you have the argument types. The
[project layout guide](https://bounda.dev/guides/project-layout/) covers every kind of module.

`.bounda/` and `+types/` are generated; they stay out of git.
