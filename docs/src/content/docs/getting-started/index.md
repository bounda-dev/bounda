---
title: Getting started
description: Create a project, run it, add a command, test it. Fifteen minutes.
sidebar:
  order: 0
---

:::caution[0.x]
Until 1.0 the API can still change between minor versions (0.1 to 0.2), and every change that
breaks something is called out in the changelog of the package it touches.
:::

## Create a project

```bash
npm create bounda@latest my-shop
cd my-shop
```

`@latest` on purpose: npx reuses a `create-bounda` it cached earlier, and a stale one pins the
Bounda packages to whatever version it shipped with.

The command asks how the app runs: a Node script, a [React Router](/guides/react-router/) app
with a page that dispatches from an action and reads from a loader, or a
[Cloudflare](/adapters/cloudflare/) Worker with a Durable Object per tenant. For Node and React
Router it then asks for a database, SQLite or PostgreSQL; on Cloudflare the store is the
object's own SQLite. Pass `--framework` and `--database` to skip the questions. With the defaults
you get a project with one aggregate, one read model and a test, on SQLite:

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
src/main.ts                 boots the app and places an order
```

Installing ran `bounda generate` for you (it is the `prepare` script), so the types are already
there. Run the test and the demo:

```bash
npm test
npm start
```

## What a module looks like

Every file exports the functions its concept needs and gets its argument types from a generated
`+types` module next to it:

```ts
// app/domain/order/commands/place-order.ts
import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/place-order";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ orderId: z.uuid(), customerId: z.string().min(1), total: z.number().positive() });

export const handler = ({ command, state, events }: Command.HandlerArgs) => {
  if (state.status !== undefined) {
    throw new DomainError(`Order ${command.aggregateId} was already placed`);
  }
  return [events.orderPlaced({ customerId: command.payload.customerId, total: command.payload.total })];
};
```

`command.payload` is typed from the Zod schema above it, `state` from what the order's events
return, and `events` only offers the events of this aggregate. `order-placed.ts` opens the order
with `create`, so before it every field of `state` is `undefined`, and after it `status` and the
rest are always set. Nothing here is registered anywhere: the file's place
and name are the declaration. The [project layout](/guides/project-layout/) guide has the whole
map.

## Add a command

Let customers cancel. Start the generator in watch mode in one terminal:

```bash
npm run dev
```

Add the event:

```ts
// app/domain/order/order-cancelled.ts
import type { Event } from "./+types/order-cancelled";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ reason: z.string() });

export const apply = () => ({ status: "cancelled" as const });
```

`apply` returns the fields the event changes, merged over the order's state. The generator adds
`"cancelled"` to the type of `status` on its own.

Add the command:

```ts
// app/domain/order/commands/cancel-order.ts
import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/cancel-order";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ orderId: z.uuid(), reason: z.string().min(1) });

export const handler = ({ command, state, events }: Command.HandlerArgs) => {
  if (state.status !== "placed") throw new DomainError("Only placed orders can be cancelled");
  return [events.orderCancelled({ reason: command.payload.reason })];
};
```

The watcher wrote `+types/order-cancelled.ts` and `+types/cancel-order.ts` as you saved, and
`events.orderCancelled` appeared in every handler of the aggregate. Reflect the cancellation in
the read model with a projection named after the event, in the folder of its aggregate:

```ts
// app/read/orders/projections/order/order-cancelled.ts
import type { Projection } from "./+types/order-cancelled";

export const project = async ({ event, table }: Projection.Args) => {
  await table.delete({ orderId: event.aggregateId });
};
```

## Test it

`createTestApp` runs the whole app on an in-memory adapter with a clock that only moves when you
tell it to. `runUntilIdle` runs projections, policies and processes until nothing is left:

```ts
// tests/cancel.test.ts
import { createTestApp } from "@bounda-dev/core/testing";
import { expect, it } from "vitest";
import { registry } from "../.bounda/registry.ts";

it("removes a cancelled order from the list", async () => {
  const { app } = await createTestApp({ registry });
  const orderId = "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01";
  await app.commands.placeOrder({ orderId, customerId: "ada", total: 42 });
  await app.commands.cancelOrder({ orderId, reason: "changed my mind" });
  await app.runUntilIdle();

  expect(await app.queries.listOrders({ customerId: "ada" })).toEqual({ orders: [], total: 0 });
  await app.stop();
});
```

```bash
npm test
```

[Testing](/guides/testing/) goes further: advancing the clock for reminders and time-outs, running
against a real database, and choosing which implementation of a dependency a test gets.

## Run it for real

`src/main.ts` shows the production path: `boot()` reads `bounda.config.ts` and the generated
registry, opens the database and returns the app. It is typed for your project: the generator's
`.bounda/register.d.ts` registers the registry type with `@bounda-dev/core/register`, so `app.commands`
knows your commands without a type argument.

```ts
import { boot } from "@bounda-dev/core/node";

const app = await boot();
await app.commands.placeOrder({ orderId: crypto.randomUUID(), customerId: "ada", total: 42 });
await app.runUntilIdle();
```

Point `bounda.config.ts` at PostgreSQL when one process is not enough; the app does not change.
See [adapters](/adapters/).

## Where next

- [Project layout](/guides/project-layout/): every kind of module, with a template each.
- [The storefront example](/guides/storefront-example/): policies, a checkout that compensates
  when the payment fails, an effect after the commit and hand-written SQL in one small app.
- [Bounda with React Router](/guides/react-router/): actions that dispatch, loaders that query,
  and the [onboarding example](/guides/onboarding-example/) that puts it together.
- [Testing](/guides/testing/): an app in memory, a clock you move by hand, and assertions that
  do not flake.
- [Reacting to events](/guides/reacting-to-events/): policies, processes, retries, and what to do
  with a dead letter.
- [Sagas and compensation](/guides/sagas/): a business transaction of several steps, and how each
  one is undone when a later one fails.
- [Changing an event's shape](/guides/changing-events/): an upcaster next to the event, applied as
  old events are read.
- [Deployment](/guides/deployment/): roles, several instances, rebuilding a read model,
  observability, and the honest list of what is not there yet.
- [How Bounda runs](/guides/how-it-runs/): one log per store, the ceiling with numbers, and the
  way out when you reach it.
- [CLI](/reference/cli/): `bounda generate`, `bounda rebuild` and `bounda dead-letters`.
