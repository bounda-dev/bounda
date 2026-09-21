---
title: Project layout
description: "Where files go and what their names mean. The generator reads the layout; you never register anything by hand."
sidebar:
  order: 0
---

A Bounda app is a tree of small modules. Each file is one concept and exports the functions that
concept needs; the folder it sits in and its name say what it is. `bounda generate` reads the tree
and writes the registry and the types, so there is no central file to keep in sync.

```
app/
  domain/
    order/                          an aggregate
      state.ts                      optional: initialState and aggregateId
      order-placed.ts               an event: payload and apply
      order-paid.ts
      commands/
        pay-order.ts                a command: payload and handler
        place-order/                a command with collaborators
          index.ts
          inventory.fake.ts         collaborator "inventory", implementation "fake"
      policies/
        send-receipt-on-order-paid.ts   reacts to OrderPaid
      processes/
        order-payment/              a process
          index.ts                  config and state
          on-order-paid.ts          handler for OrderPaid
          on-timeout.ts             handler for the time-out
  read/
    order-summary/                  a read model
      view.ts                       fields
      projections/
        order-placed.ts             reacts to OrderPlaced
      queries/
        get-order.ts                payload, repository, handler
```

## Names

File and directory names are kebab-case: lower-case letters, digits and dashes. The generator turns
them into the names your code sees:

| File | Registry key | Type name |
| --- | --- | --- |
| `order-placed.ts` | `orderPlaced` | `OrderPlaced` |
| `place-order/index.ts` | `placeOrder` | `PlaceOrder` |
| `send-receipt-on-order-paid.ts` | `sendReceiptOnOrderPaid` | reacts to `OrderPaid` |
| `on-order-paid.ts` | handler for `orderPaid` | |
| `inventory.fake.ts` | collaborator `inventory`, implementation `fake` | |
| `order-summary/` | `orderSummary` | `OrderSummaryRow` |

Files that start with `_` or `.`, tests (`*.test.ts`, `*.test-d.ts`), declarations (`*.d.ts`) and
`+types` directories are ignored.

## Aggregates: `app/domain/<aggregate>/`

Every `.ts` file at the root of the aggregate is an event, except `state.ts`.

```ts
// app/domain/order/order-placed.ts
import type { Event } from "./+types/order-placed";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ customerId: z.string(), total: z.number().positive() });

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  status: "placed" as const,
  customerId: event.payload.customerId,
  total: event.payload.total,
});
```

`payload` is optional; an event without one has an empty payload. `apply` returns the next state.

### State

Without `state.ts`, the generator infers the aggregate's state from what every `apply` returns:
each field is optional and its type is the union of what the events assign. `status` above,
together with an `order-paid.ts` that sets `"paid"`, becomes `status?: "placed" | "paid"`.

Add `state.ts` when you want fields with an initial value and no `undefined`, or when a field's
type is not visible from outside its module:

```ts
// app/domain/order/state.ts
export const initialState = {
  status: "new" as "new" | "placed" | "paid",
  customerId: "",
  total: 0,
};
export const aggregateId = "orderId";
```

`aggregateId` names the payload field that identifies the aggregate. It defaults to
`<aggregate>Id`, so `orderId` for `order`.

### Commands: `commands/`

A command is `commands/<name>.ts` or, when it has collaborators, `commands/<name>/index.ts`.

```ts
// app/domain/order/commands/place-order/index.ts
import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/index";

export type Collaborators = {
  inventory: { reserve: (skus: readonly string[]) => Promise<void> };
};

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ orderId: z.uuid(), customerId: z.string(), total: z.number().positive() });

export const handler = async ({ command, state, events, inventory }: Command.HandlerArgs) => {
  if (state.status !== "new") throw new DomainError("Order already placed");
  await inventory.reserve([]);
  return [events.orderPlaced({ customerId: command.payload.customerId, total: command.payload.total })];
};
```

Collaborators are the things a handler needs from outside: a payment gateway, a clock, a mailer.
Each implementation is a file `<collaborator>.<implementation>.ts` next to `index.ts` with a
default export; `bounda.config.ts` picks one per environment:

```ts
export default defineConfig({
  storage: sqlite({ path: "./data/app.db" }),
  commands: { placeOrder: { inventory: { use: "fake" } } },
});
```

Export a `Collaborators` type when the implementations are looser than the contract, as the fake
above that ignores its argument. Without it, the type is inferred from the implementations.

### Policies: `policies/`

A policy reacts to an event with commands. `<action>-on-<event>.ts` names the event; a policy
without `-on-` exports `on` with the event type names it reacts to.

```ts
// app/domain/order/policies/send-receipt-on-order-paid.ts
import type { Policy } from "./+types/send-receipt-on-order-paid";

export const handler = async ({ event, commands }: Policy.HandlerArgs) => {
  await commands.sendReceipt({ orderId: event.aggregateId, method: event.payload.method });
};
```

Policies dispatch through `commands`, the typed facade of every command in the app. A command can
be delayed: `commands.sendReminder({ orderId }, { delay: "24h" })`. The compiler checks a literal
duration; for one that comes from the environment, `asDuration` from `@bounda-dev/core` checks it
at the call site and returns it typed.

### Processes: `processes/<name>/`

A process follows an aggregate instance over time. `index.ts` says which events start and complete
it and how long it may stay open; `on-<event>.ts` handles an event while it is open; `on-timeout.ts`
runs when the time is up.

```ts
// app/domain/order/processes/order-payment/index.ts
import type { Process } from "./+types/index";

export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.OrderPlaced],
  completedBy: [events.OrderPaid, events.OrderCancelled],
  timeout: "48h",
});

export const state = ({ z }: Process.StateArgs) => z.object({ reminders: z.int().default(0) });
```

## Read models: `app/read/<read-model>/`

`view.ts` declares the table; projections fill it; queries read it.

```ts
// app/read/order-summary/view.ts
import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  orderId: f.string().primaryKey(),
  customerId: f.string().index(),
  status: f.string(),
  total: f.number(),
  paidAt: f.date().optional(),
});
```

A projection `projections/<event>.ts` reacts to that event, or exports `on` for several:

```ts
// app/read/order-summary/projections/order-placed.ts
import type { Projection } from "./+types/order-placed";

export const project = async ({ event, table }: Projection.Args) => {
  await table.upsert({
    orderId: event.aggregateId,
    customerId: event.payload.customerId,
    status: "placed",
    total: event.payload.total,
  });
};
```

A query `queries/<name>.ts` has an optional `payload`, an optional `repository` that reads
through `table` or `client`, and a `handler` that shapes the result and may call other queries:

```ts
// app/read/order-summary/queries/get-order.ts
import type { Query } from "./+types/get-order";

export const payload = ({ z }: Query.PayloadArgs) => z.object({ orderId: z.uuid() });

export const repository = ({ table, orderId }: Query.RepositoryArgs) => table.findOne({ orderId });

export const handler = ({ repositoryData }: Query.HandlerArgs) => repositoryData;
```

## Generated files

`bounda generate` writes:

| Path | Holds |
| --- | --- |
| `.bounda/registry.ts` | Every module, grouped as the runtime needs it. `boot()` imports it |
| `.bounda/types.ts` | The state, events, commands, rows and queries maps the `+types` build on |
| `**/+types/<name>.ts` | The argument types each module imports |

They are derived from your code, so they are not versioned. Add to `.gitignore`:

```
.bounda/
**/+types/
```

and run the generator before anything type-checks, typically as `prepare` in `package.json`:

```json
{ "scripts": { "prepare": "bounda generate", "dev": "bounda generate --watch" } }
```

If your formatter or linter picks up generated files, exclude the same two patterns; their layout
is fixed by the generator.
