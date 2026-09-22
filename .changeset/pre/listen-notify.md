---
"@bounda-dev/core": patch
"@bounda-dev/adapter-postgresql": patch
---

`LISTEN`/`NOTIFY`. The PostgreSQL adapter ends every append's transaction with `pg_notify` on a
channel named after the events table and exposes a notifier that `LISTEN`s on it; the dispatcher
runs a pass the moment a notification arrives and, once passes stop finding events, polls only
every `runtime.dispatcher.idleInterval` (30 seconds by default) as a safety net. A policy on
PostgreSQL reacts in milliseconds and an idle worker barely touches the database. `StoragePorts`
gains an optional `notifier`; SQLite has none and polls as before; the in-memory adapter notifies
within the process.
