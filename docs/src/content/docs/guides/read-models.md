---
title: Read models
description: The table a read model declares, the projections that fill it from events, the queries that read it and filter it, and the ports its queries may call.
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

Each field is a column: `f.string()`, `f.number()`, `f.boolean()`, `f.date()` or `f.json<T>()`,
then `.optional()`, `.primaryKey()` (exactly one), `.unique()` or `.index()`. Two more say what
the column means rather than how it is stored: `.person()` marks the column that holds the id of
the person the row is about, a string, at most one per read model, and `.personal()` a column
that holds that person's data:

```ts
// app/read/customer-directory/view.ts
export const fields = ({ f }: View.FieldsArgs) => ({
  customerId: f.string().primaryKey().person(),
  email: f.string().optional().personal(),
  plan: f.string(),
});
```

A person's export then carries their rows, a query of the read model is recorded in the access
log, and the read model must handle forgetting: see
[Personal data in read models](/guides/personal-data/#personal-data-in-read-models).

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

A projection of an event with a field marked `personal` sees it as `T | null`, and the read model
then projects `PersonalDataForgotten` too, from `projections/bounda/personal-data-forgotten.ts`:
see [Personal data](/guides/personal-data/#personal-data-in-read-models).

## The table

Projections and queries receive `table`, typed from the view. `upsert` and `insert` take a whole
row, `update(where, patch)` sets the fields of `patch` in the rows that match, `delete(where)`
removes them, and `findOne(where)`, `findMany({ where, orderBy, limit, offset })` and
`count(where)` read. Every write is idempotent, so a redelivered event does no harm: `upsert`
replaces, `insert` leaves a primary key already there alone, and `update` and `delete` do nothing
when no row matches.

A `where` names fields that must all match. Each takes a value, matched by equality (`null` for an
optional field without one), or operators:

| Operator | Matches | On |
| --- | --- | --- |
| `gt`, `gte`, `lt`, `lte` | rows above or below the operand; none without a value | strings, numbers, dates |
| `ne` | rows with any other value, and those without one; `ne: null`, those with one | strings, numbers, dates, booleans |
| `in` | rows with one of the values; `in: []` matches none | strings, numbers, dates, booleans |

```ts
const orders = await table.findMany({
  where: {
    customerId,
    paidAt: { gte: from, lt: to },
    status: { in: ["paid", "shipped"] },
    total: { gt: 0 },
  },
  orderBy: { field: "paidAt", direction: "desc" },
  limit: 20,
});
```

The operators of one field all hold, and one left `undefined` adds nothing, so an optional bound
passes straight through. A field whose operators have no value at all is refused with
`ConfigurationError` rather than matching every row, so a missing list in
`delete({ orderId: { in: ids } })` cannot empty the table: leave the field out to match any row.
A `json` field matches by equality only, whatever its value, and cannot be
the primary key: an object there is the value to match, not operators. The table is typed from
the view, so the types refuse a range on a boolean and any operator on a `json` field, even one
whose values are strings. The runtime refuses a range on a boolean too, and a field or an
operator the view does not know, with `ConfigurationError`.

Every database orders rows alike, in `where` as in `orderBy`: strings by code point, so `"B"`
comes before `"a"`, `"a-b"` before `"ab"`, and `"z"` before `"á"`, and rows without a value first
going up and last going down. A page, a range or a test gives the same rows on SQLite, PostgreSQL,
Cloudflare and in memory.

`offset` pages through rows as they are at each call, so a projection that writes between two
pages can make a row skip or repeat. To page through rows that keep changing, page by the primary
key instead:

```ts
const page = await table.findMany({
  where: { customerId, orderId: { gt: lastOrderId } },
  orderBy: { field: "orderId", direction: "asc" },
  limit: 50,
});
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

A query run through a client bound with
[`as(actor)`](/concepts/ids-causation-and-correlation/#who-acts) receives that `actor` in its
`repository` and its `handler`, `undefined` when the client names nobody, so it can read only what
whoever asks may see:

```ts
// app/read/support-tickets/queries/my-tickets.ts
import type { Query } from "./+types/my-tickets";

export const repository = ({ table, actor }: Query.RepositoryArgs) =>
  actor === undefined
    ? []
    : table.findMany({ where: { assignee: actor, status: { ne: "closed" } } });

export const handler = ({ repositoryData }: Query.HandlerArgs) => repositoryData;
```

The queries a handler composes run as the same actor. A query with a `repository` cannot name a
payload field `client`, `table` or `actor`, which the repository receives as its own: the app
refuses to start.

### Restricted rows

A query never reads the rows of a person whose processing is
[restricted](/guides/personal-data/#restricting-processing): those whose field marked `.person()`
names someone restricted as a whole, or restricted in a category a field marked `.personal()`
holds, or whose such category a forgetting kept under a legal obligation. `table` leaves them out
in its own statement, so `findMany` with a `limit` fills the page with the others and `count`
counts the others. `client.get` and `client.all` run your SQL as it is and drop those rows from
what it answers, so a `LIMIT` in it may return fewer rows, and `client.get` answers `null` when
the one row it read is left out, though others match: read through `table` where paging or the
first match must be exact. A row your SQL answers with a field marked `.personal()` and without the one marked
`.person()` cannot be told apart, and the query rejects with `ConfigurationError`: select the person
field too. What a query reads through `client.raw`, the driver itself, nobody filters. Who is
restricted is read from a copy each database holding such read models keeps, written from the
stream as a projection is: until it catches up with a `restrict` or a lift, queries read as
before it, and `catchUpReadModels({ through })` with what `restrict` resolved to waits for it.

A query that must read restricted rows names the basis it reads them on, which article 18(2)
allows, and the access log records it with the restricted persons whose rows it read:

```ts
const invoices = await app.queries.invoicesOf(
  { customerId: "c-42" },
  { includeRestricted: "legal-obligation" },
);
```

`legal-obligation` reads what a forgetting kept under a legal obligation and still leaves out what
a person asked to restrict; `consent`, `legal-claims`, `protection-of-rights` and `public-interest`
read every row. The queries its handler composes read on the same basis unless they pass their
own.

Each database that holds a read model with a field marked `.person()` keeps a copy of who is
restricted, `<prefix>restricted_persons`, which the runtime writes from the stream as a projection
does, so a read model in a database of its own filters the same way. `catchUpReadModels({ through
})` of a `restrict`, `unrestrict` or `forget` waits for it.

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
