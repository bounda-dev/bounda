---
title: Read models
description: The table a read model declares, the projections that fill it from events, the queries that read it, and the ports its queries may call.
sidebar:
  order: 1
---

A read model is a table built from events, under `app/read/<read-model>/`. It is the read side of
the app: commands never read it, and queries never touch the event store.

## The view

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

## Projections

A projection `projections/<aggregate>/<event>.ts` reacts to that aggregate's event, or exports
`on` for several of that aggregate's events:

```ts
// app/read/order-summary/projections/order/order-placed.ts
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

## Queries

A query `queries/<name>.ts` has an optional `payload`, an optional `repository` that reads
through `table` or `client`, and a `handler` that shapes the result and may call other queries:

```ts
// app/read/order-summary/queries/get-order.ts
import type { Query } from "./+types/get-order";

export const payload = ({ z }: Query.PayloadArgs) => z.object({ orderId: z.uuid() });

export const repository = ({ table, orderId }: Query.RepositoryArgs) => table.findOne({ orderId });

export const handler = ({ repositoryData }: Query.HandlerArgs) => repositoryData;
```

Payload fields with a `.default()` are optional for whoever calls the command or query and
always present in the handler: callers see the schema's input type, handlers its output type.

The root of a read model is read like an aggregate's, without events: `view.ts`, the ports, and
any other module or directory the projections and queries share, which the generator leaves
alone. A projection or a query put in the wrong place gets a
[warning](/reference/conventions/#what-the-generator-warns-about).

## Ports

A read model's port is declared and implemented as an aggregate's
([ports](/guides/project-layout/#ports-portts)), and only the `handler` of its queries receives it:
a query that completes its rows with something from outside, an exchange rate or a profile from the
identity provider.

```ts
// app/read/order-summary/queries/get-order-in-usd.ts
import type { Query } from "./+types/get-order-in-usd";

export const repository = ({ table, orderId }: Query.RepositoryArgs) => table.findOne({ orderId });

export const handler = async ({ repositoryData, rates }: Query.HandlerArgs) =>
  repositoryData && {
    ...repositoryData,
    totalUsd: repositoryData.total * (await rates({ from: "EUR", to: "USD" })),
  };
```

A query only reads, so it needs no `idempotencyKey`, and a port that fails fails the query. The
config chooses its implementation in the same `ports` section, `ports: { orderSummary: { rates:
"ecb" } }`, and a read model's port cannot take one of the
[reserved names](/reference/conventions/#what-the-generator-refuses).

`repository` reads the storage and gets no ports, and neither do the projections: a projection
commits exactly once per batch with its checkpoint, replays its whole history on a rebuild and
runs in the command's request under read-your-writes, and a call to the outside fits none of
those. [Your projection should not call anyone](/concepts/projections-call-no-one/) has the
reasons in full.

Data from outside belongs in the event, fetched when the command or the policy decides, or in the
query, fetched when it is read. An index kept in another store, such as Typesense or
Elasticsearch, is fed by a policy instead: see
[keeping an external index](/guides/calling-the-outside-world/#keeping-an-external-index).
