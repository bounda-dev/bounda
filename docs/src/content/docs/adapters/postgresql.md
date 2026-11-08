---
title: PostgreSQL
description: PostgreSQL through Postgres.js, for apps that run more than one instance.
sidebar:
  order: 2
---

`@bounda-dev/postgresql` stores everything in PostgreSQL through
[Postgres.js](https://github.com/porsager/postgres).

```ts
import { postgresql } from "@bounda-dev/postgresql";

postgresql({ url: process.env.DATABASE_URL! });
postgresql({ host: "localhost", port: 5432, database: "shop", user: "shop", password: "…" });
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | | A `postgres://` connection URL |
| `host`, `port`, `database`, `user`, `password`, `ssl` | | The same, as parts |
| `schema` | `public` | The schema that holds every Bounda table; created if missing |
| `tablePrefix` | `bounda_` | Put in front of every table Bounda creates |
| `maxConnections` | `10` | Size of the connection pool |

## How it stores things

- `position` in the events table is a `BIGSERIAL`. Every append takes a transaction-scoped advisory
  lock (`pg_advisory_xact_lock`) before writing, so positions are handed out in commit order and a
  reader of the global stream never sees a gap that a later commit would fill. The lock bounds write
  throughput to what one connection can commit
  ([the ceiling, and one store per tenant with `schema`](/concepts/how-it-runs/#the-ceiling-with-numbers)).
  The lock, like the notification channel and the read models' locks below, belongs to the
  store's `schema`, so stores in two schemas of one database never wait on each other.
- The stream version is checked in the same transaction as the write; a stale version rolls back
  with a `ConcurrencyError` and the command is retried with fresh state. So are the people the
  events name: the rows of their keys and of `bounda_persons` are read under a share lock, after
  the advisory lock that `forget` and `restrict` also take first, so a person forgotten or
  restricted beside the append is so before it or after it, never across.
- The transaction ends with `pg_notify` on a channel named after the schema and the events
  table (`public.bounda_events` by default), carrying the last position written. PostgreSQL
  delivers it at commit. Every worker listens on that channel through a dedicated connection Postgres.js keeps
  open and re-establishes on its own, and runs a dispatcher pass as soon as it hears; between
  notifications it polls only every `runtime.dispatcher.idleInterval`. See
  [Tuning](/guides/deployment/#tuning).
- Handler claims are single `INSERT … ON CONFLICT DO UPDATE … RETURNING` statements; due
  scheduled commands are taken with `FOR UPDATE SKIP LOCKED`. Any number of instances can run the
  worker role and each due command is claimed by one of them at a time.
- Payloads and metadata are `jsonb`; read-model booleans, dates and JSON fields use `boolean`,
  `timestamp with time zone` and `jsonb`. Numbers are `double precision`. Strings are
  `text COLLATE "C"`, which compares them by code point as SQLite does, so a range, an `orderBy`
  and hand-written SQL over the column find the rows in the same order on both. The collation also
  folds case in ASCII only, again as SQLite does: in hand-written SQL, `lower()`, `upper()` and
  `ILIKE` leave `Á` as it is, unless the expression names another collation
  (`lower("name" COLLATE "und-x-icu")`, on a server built with ICU).

Storage and read models opened from the same `postgresql(...)` share one pool, closed when the
app stops.

## In tests

The adapter's own tests start `postgres:17` with [Testcontainers](https://node.testcontainers.org/),
and the same works for an app: see
[against a real database](/guides/testing/#against-a-real-database).
