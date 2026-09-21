---
name: bounda
description: Build event-sourced TypeScript apps with Bounda. Use when working in a project that has a bounda.config.ts, when the user mentions aggregates, commands, events, policies, processes, projections or read models in a Bounda codebase, or asks to add a feature to a Bounda app.
---

# Bounda

Bounda is an event sourcing and CQRS framework for TypeScript. An app is a tree of small modules
under `app/`; each file is one concept and exports the functions that concept needs. Types are
generated from the file layout, so you never write a registry or an argument type by hand.

## The two rules

1. **The file name and its folder are the declaration.** `app/domain/order/order-placed.ts` is the
   event `OrderPlaced` of the aggregate `order`. Names are kebab-case.
2. **Types come from `./+types/<file-name>`.** Every module starts with
   `import type { X } from "./+types/<same name>"` and annotates its exports with `X.<Something>Args`.
   Run `bounda generate` after adding, renaming or deleting a module; `bounda generate --watch`
   keeps up while you work.

Never edit anything under `.bounda/` or a `+types/` directory; both are generated and gitignored.

## Layout

```
app/domain/<aggregate>/
  state.ts                         optional: export const initialState = {...}; export const aggregateId = "<field>"
  <event>.ts                       export const payload (optional), export const apply
  commands/<command>.ts            export const payload, export const handler
  commands/<command>/index.ts      same, with <collaborator>.<implementation>.ts files beside it
  policies/<action>-on-<event>.ts  export const handler
  processes/<process>/index.ts     export const config, export const state (optional)
  processes/<process>/on-<event>.ts, on-timeout.ts   export const handler
app/read/<read-model>/
  view.ts                          export const fields
  projections/<event>.ts           export const project
  queries/<query>.ts               export const payload (optional), repository (optional), handler
bounda.config.ts                   export default defineConfig({ storage, readModels?, runtime?, commands? })
```

## Templates

Event:

```ts
import type { Event } from "./+types/order-placed";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ total: z.number().positive() });

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  status: "placed" as const,
  total: event.payload.total,
});
```

Command (the payload must carry the aggregate id field, `orderId` for `order` unless `state.ts`
says otherwise):

```ts
import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/pay-order";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ orderId: z.uuid(), method: z.enum(["card", "transfer"]) });

export const handler = ({ command, state, events }: Command.HandlerArgs) => {
  if (state.status !== "placed") throw new DomainError("Only placed orders can be paid");
  return [events.orderPaid({ method: command.payload.method })];
};
```

Command with a collaborator (`commands/place-order/index.ts` plus `inventory.fake.ts` with a
default export; `bounda.config.ts` selects it with `commands: { placeOrder: { inventory: { use: "fake" } } }`):

```ts
export type Collaborators = { inventory: { reserve: (skus: readonly string[]) => Promise<void> } };

export const handler = async ({ command, events, inventory }: Command.HandlerArgs) => {
  await inventory.reserve(command.payload.lines.map((line) => line.sku));
  return [events.orderPlaced(command.payload)];
};
```

Policy (`policies/send-receipt-on-order-paid.ts`):

```ts
import type { Policy } from "./+types/send-receipt-on-order-paid";

export const handler = async ({ event, commands }: Policy.HandlerArgs) => {
  await commands.sendReceipt({ orderId: event.aggregateId });
};
```

Process (`processes/order-payment/index.ts` and `on-order-paid.ts`, `on-timeout.ts`):

```ts
import type { Process } from "./+types/index";

export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.OrderPlaced],
  completedBy: [events.OrderPaid, events.OrderCancelled],
  timeout: "48h",
});
export const state = ({ z }: Process.StateArgs) => z.object({ reminders: z.int().default(0) });
```

```ts
import type { Process } from "./+types/on-timeout";

export const handler = async ({ state, aggregateId, commands }: Process.TimeoutArgs) => {
  await commands.cancelOrder({ orderId: aggregateId, reason: "payment timeout" });
  return { ...state, reminders: state.reminders + 1 };
};
```

Read model (`view.ts`, `projections/order-placed.ts`, `queries/get-order.ts`):

```ts
import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  orderId: f.string().primaryKey(),
  status: f.string(),
  total: f.number(),
  paidAt: f.date().optional(),
});
```

```ts
import type { Projection } from "./+types/order-placed";

export const project = async ({ event, table }: Projection.Args) => {
  await table.upsert({ orderId: event.aggregateId, status: "placed", total: event.payload.total });
};
```

```ts
import type { Query } from "./+types/get-order";

export const payload = ({ z }: Query.PayloadArgs) => z.object({ orderId: z.uuid() });
export const repository = ({ table, orderId }: Query.RepositoryArgs) => table.findOne({ orderId });
export const handler = ({ repositoryData }: Query.HandlerArgs) => repositoryData;
```

## Rules of the runtime

- A command handler returns the events to append, built with `events.<eventKey>(payload)`. It may
  only build events of its own aggregate. Throw `DomainError` to reject a command.
- `state` in a handler carries `id` and `version` besides the aggregate's fields. Without
  `state.ts` every field is optional (`state.status === undefined` means a fresh aggregate).
- Policies and process handlers get `commands`, the typed facade of every command in the app, and
  run with at-least-once delivery: make them idempotent or let the runtime's inbox do it (it does
  by default, per event).
- Projections write through `table` (`upsert`, `insert`, `update`, `delete`, `findOne`,
  `findMany`, `count`); every write is idempotent, so redelivery is safe.
- Queries compose: a handler receives `queries` and may call other queries.
- Delayed commands: `commands.remindCustomer(payload, { delay: "24h" })`. A duration from the
  environment is a `string`; wrap it: `{ delay: asDuration(process.env.DELAY ?? "24h") }`.
- Payload fields with `.default()` are optional for callers (`commands.x()`, `queries.x()` take
  the schema's input type) and always present in handlers (output type).
- A command resolves when its events are stored; read models catch up in the background.
  `app.catchUpReadModels()` runs the projections now; `readYourWrites(app)` returns an app whose
  commands do that before resolving. Hosts such as the React Router package apply it for you.

## Bounda with React Router

`@bounda-dev/react-router` boots the app from a middleware and puts it in the router context.
Bounda's `app/domain` and `app/read` live next to `app/routes`; the generator ignores the rest.

```ts
// app/bounda.server.ts
import { boot } from "@bounda-dev/core/node";
import { createBounda } from "@bounda-dev/react-router";
import { registry } from "../.bounda/registry.ts";

export const { bounda, boundaMiddleware } = createBounda({ boot: () => boot({ registry }) });

// app/root.tsx
export const middleware: Route.MiddlewareFunction[] = [boundaMiddleware];

// a route: actions dispatch, loaders query
export const action = async ({ request, context }: Route.ActionArgs) => {
  await context.get(bounda).commands.registerUser(await payloadOf(request));
  return redirect("/users");
};
export const loader = ({ context }: Route.LoaderArgs) => context.get(bounda).queries.listUsers({});
```

- Import the registry by value in `bounda.server.ts`: in development a change under `app/domain`
  or `app/read` re-evaluates the module and the app reboots from the new code.
- The app in the context reads its own writes by default (`consistency: "immediate"`): a page
  reached right after a command sees its read models. Never call `processUntilIdle()` in a route.
- Map `ValidationError` to a 400 with `error.issues` and `DomainError` to a 409 in one helper;
  let anything else reach the `ErrorBoundary`.
- Typecheck with `react-router typegen && tsc`; `.react-router/types` holds the route types and
  Bounda's `+types` sit next to the modules. They do not clash.

## Working in a Bounda repo

- After changing the layout: `bounda generate`, then type-check. Convention problems exit with
  code 1 and name the file; fix the name or the location.
- Tests: `createTestApp({ registry, adapter? })` from `@bounda-dev/core/testing` gives an app on the
  in-memory adapter with a fixed clock (`clock.advance(ms)`) and sequential ids; call
  `await app.processUntilIdle()` after dispatching to run policies, processes and projections.
  `import { registry } from "../.bounda/registry.ts"`.
- `boot()` from `@bounda-dev/core/node` is typed for the project without a type argument:
  `.bounda/register.d.ts` registers the registry type with `@bounda-dev/core/register`. Never write
  `boot<typeof registry>()`.
- Storage: `sqlite({ path })`, `sqlite({ memory: true })` or `postgresql({ url })` in
  `bounda.config.ts`; read models can point at a different adapter with `readModels`.
