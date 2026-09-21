---
title: Storage adapters
description: One database holds events, checkpoints, scheduled commands, dead letters and read models. An adapter tells Bounda which one.
sidebar:
  order: 0
---

Bounda runs on a single database. Events, the checkpoints of every subscriber, scheduled
commands, dead letters and the tables of your read models all live there, so there is no broker
or queue to operate. An adapter is the piece that knows how to talk to one engine.

```ts
// bounda.config.ts
import { defineConfig } from "@bounda-dev/core/config";
import { sqlite } from "@bounda-dev/adapter-sqlite";

export default defineConfig({
  storage: sqlite({ path: "./data/app.db" }),
});
```

`storage` is where the write side lives. Read models use the same adapter unless you point one
of them elsewhere:

```ts
export default defineConfig({
  storage: postgresql({ url: process.env.DATABASE_URL! }),
  readModels: {
    orderSummary: sqlite({ path: "./data/reporting.db" }),
  },
});
```

## Available adapters

| Adapter | Package | Engine |
| --- | --- | --- |
| [SQLite](/adapters/sqlite/) | `@bounda-dev/adapter-sqlite` | A local file, memory, or a libSQL server such as Turso |
| [PostgreSQL](/adapters/postgresql/) | `@bounda-dev/adapter-postgresql` | PostgreSQL 14 or newer |
| In-memory | `@bounda-dev/core/memory` | Nothing; for tests and for trying Bounda without a database |

Every adapter passes the same contract test suites, so an app behaves the same way on each of
them. Pick SQLite to start and move to PostgreSQL when you need several processes writing at
once; your domain code does not change.

## What an adapter creates

On first use the adapter creates its tables, prefixed with `bounda_` by default:

| Table | Holds |
| --- | --- |
| `bounda_events` | Every event, with its stream version and a global position |
| `bounda_checkpoints` | How far each projection, the policy runner and the process runner have read |
| `bounda_inbox` | Which handler already ran for which event, so retries never run a handler twice |
| `bounda_scheduled_commands` | Delayed commands and process time-outs |
| `bounda_dead_letters` | Handler runs that gave up, with the error and the attempt count |

Read models get one table each, named after the read model in snake_case: `orderSummary` becomes
`bounda_order_summary`. Its columns come from the `fields` of the view, also in snake_case.

## Evolving a read model

Adding a field to a view adds a nullable column the next time the app starts; existing rows keep
working. Removing a field or changing its type is refused with an error that names the read
model: rename the read model instead and it is rebuilt from scratch. Rebuilding in place is
planned.

## Hand-written SQL

A query's `repository` receives `client` for SQL you write yourself. Rows come back with the
column names in camelCase and the values decoded from the view's field types; `client.raw` is
the driver, for anything the adapter does not cover.

```ts
export const repository: Query.RepositoryFunction = ({ customerId, client }) =>
  client.all(
    "SELECT order_id, total FROM bounda_order_summary WHERE customer_id = ? ORDER BY total DESC",
    [customerId],
  );
```

Placeholders are the driver's: `?` on SQLite, `$1`, `$2` on PostgreSQL. A query written in SQL
is tied to one of them; `table` (`findMany`, `count`, ...) works on both.
