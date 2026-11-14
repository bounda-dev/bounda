---
title: What is not there yet
description: What a production app might want from Bounda and does not get today, and why.
sidebar:
  order: 5
---

Bounda is 0.x, and this is the honest list of what a production app might want and does not
get today. Each item says why, so nobody discovers it the hard way:

- **Changing the shape of a process's state.** A process keeps its state in its own lifecycle
  events, so a change to that shape has the same problem an event payload has, and no
  `state.upcast.ts` yet. See
  [Changing an event's shape](/guides/changing-events/#what-is-not-covered-yet).
- **Renaming or removing an event type.** Upcasters change a payload, not a type. Keep the module,
  even if its `evolve` changes nothing. See
  [Changing an event's shape](/guides/changing-events/#what-is-not-covered-yet).
- **One trace per request.** Spans carry `bounda.correlation_id` but a policy's span is a separate
  trace from the command's, because it runs in a later pass. See
  [Observability](/reference/observability/).
- **Notifications for scheduled commands.** The worker that runs due commands polls at
  `pollInterval`; only the event dispatcher is woken by `NOTIFY`. See
  [Tuning](/guides/deployment/#tuning).
- **Every read of a field kept in the clear in the access log.** See [The access log](#the-access-log).
- **Restricted rows out of every read.** See [Restricted rows](#restricted-rows).
- **Telling those a redacted value went to.** See [Redacted values](#redacted-values).

## The access log

The [access log](/guides/personal-data/#who-opened-what) records what Bounda hands out through a
client. A read model's fields [sealed at rest](/guides/personal-data/#sealed-at-rest) open for
nothing else, so whatever goes around a client reads them as ciphertext; what the log does not see
is what is not sealed:

- **Fields kept in the clear.** A field marked `.personal({ clear: true })` is stored as it is, so
  a route that opens the read model's database, a script on its tables, or a query's `client.raw`
  reads it without a record; a query that takes `client.raw` on such a read model is recorded with
  `unattributed: true`.
- **Read models without personal fields.** A query of one is not recorded, even when its rows
  hold a person's id: an id alone is what every event already carries.
- **The global stream.** `app.events.read()` hands out events as stored, personal fields
  encrypted, so it opens nothing and is not recorded; what decrypts them, such as a projection,
  is the runtime's own work.
- **What a policy sends out.** A port that mails a person their data, or a search index, records
  what it does itself.

## Restricted rows

A [restriction](/guides/personal-data/#restricting-processing) leaves a person's rows out of what a
query reads through its `table` and its `client`, and nothing opens their sealed values without a
basis named:

- **Fields kept in the clear** are read as they are by code that reads a read model directly and by
  a query's `client.raw`.
- **SQL a query writes** has its `LIMIT` applied before the restricted rows are dropped, so a page
  may come back short; `table` pages exactly.

## Redacted values

A [redaction](/guides/personal-data/#correcting-a-persons-data) seals the fields it names in the
events; every read model hides or writes over the person's copies as it projects it, and the worker
rebuilds every one that projects an event type it reached, unless its view states it holds no
personal data. What it does not reach:

- **What a policy sent out.** A port that mailed the old value, or indexed it, corrects it itself:
  a policy on `PersonalDataRedacted` is where to tell it (article 19).

## What it does get

What a production app does get, and where it is explained:
[rebuilding a read model](/guides/deployment/#rebuilding-a-read-model) without taking it offline,
[forgetting a person](/guides/personal-data/) without deleting an event, each
[category](/guides/personal-data/#categories) of their data with its basis and retention, what a
legal obligation keeps kept,
[exporting their data](/guides/personal-data/#exporting-a-persons-data), read models included,
their read models' fields [sealed at rest](/guides/personal-data/#sealed-at-rest) with blind indexes
to look them up,
[recording who opened it](/guides/personal-data/#who-opened-what) and
[restricting their processing](/guides/personal-data/#restricting-processing) without losing a
reaction, [correcting it](/guides/personal-data/#correcting-a-persons-data) so the wrong value is
read nowhere, [forgetting them](/guides/personal-data/#retention) after a retention or when a purpose
ends, their keys [wrapped under a master key](/guides/personal-data/#a-master-key) kept out of
the database and out of JavaScript memory, their forgetting [applied again](/guides/personal-data/#backups) when a backup is
restored, and [found](/guides/personal-data/#restores) whether restored under the running app or while it was stopped,
what was written before a field was marked [sealed in
place](/guides/personal-data/#marking-a-field-later), [the status of the background
work](/reference/cli/#bounda-status) and [migrations run before a deploy](/reference/cli/#bounda-migrate),
[dead letters with a way out](/guides/dead-letters/), [upcasters](/guides/changing-events/) for
events whose payload changed, [snapshots](/concepts/long-streams/#snapshots) whose validity the
runtime checks itself, [observability](/reference/observability/) through OpenTelemetry, and a
dispatcher that reacts in milliseconds on PostgreSQL.
