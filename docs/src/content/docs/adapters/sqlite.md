---
title: SQLite
description: A file, memory, or Turso through one adapter built on libSQL.
sidebar:
  order: 1
---

`@bounda-dev/adapter-sqlite` stores everything in SQLite through
[libSQL](https://github.com/tursodatabase/libsql-client-ts). The same adapter opens a local
file, an in-memory database or a remote libSQL server such as Turso.

```ts
import { sqlite } from "@bounda-dev/adapter-sqlite";

sqlite({ path: "./data/app.db" });
sqlite({ memory: true });
sqlite({ url: "libsql://my-app-me.turso.io", authToken: process.env.TURSO_AUTH_TOKEN });
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `path` | | Path of the database file, created if missing |
| `memory: true` | | An in-memory database that lives as long as the app |
| `url`, `authToken` | | A libSQL URL (`libsql://`, `https://` or `file:`) and its token |
| `tablePrefix` | `bounda_` | Put in front of every table Bounda creates |

## How it stores things

- `position` in the events table is `INTEGER PRIMARY KEY AUTOINCREMENT`. SQLite has a single
  writer, so the global order matches commit order without extra locking.
- An append runs in `BEGIN IMMEDIATE … COMMIT`: the stream version is checked and the events are
  written inside one transaction. A stale version rolls back and the command is retried with
  fresh state.
- Claims for handlers and scheduled commands are single statements with `RETURNING`, so two
  instances of your app on the same file can never run the same handler twice.
- Booleans are stored as `0`/`1`, dates as ISO-8601 text, JSON fields as text. You never see
  that: rows come back typed from your `fields`.

Within one process the adapter serialises write transactions itself. Several processes on the
same file rely on SQLite's own locking; for that setup, or for more than one machine, use
[PostgreSQL](/adapters/postgresql/).

The SQL itself is not specific to libSQL. The stores, the schema and the read models live in
`@bounda-dev/core/adapter/sqlite`, and `createSqliteAdapter` builds a complete adapter from any
SQLite connection a host brings: this package brings libSQL, and the same code runs inside a
Cloudflare Durable Object.

## In tests

```ts
import { createTestApp } from "@bounda-dev/core/testing";
import { sqlite } from "@bounda-dev/adapter-sqlite";

const { app, clock } = await createTestApp({ registry, adapter: sqlite({ memory: true }) });
```

`createTestApp` defaults to the in-memory adapter from `@bounda-dev/core/memory`, which runs no
SQL. Use `sqlite({ memory: true })` when a test needs the real thing, for example to exercise a
query written in SQL.
