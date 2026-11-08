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
- **Every read of personal data in the access log.** See [The access log](#the-access-log).

## The access log

The [access log](/guides/personal-data/#who-opened-what) records what Bounda hands out through a
client, and nothing it does not see:

- **Code that reads a read model directly.** A route that opens the read model's database, or a
  script on the tables, goes around the queries; only a query through `app.queries` is recorded.
- **Whose rows `client.raw` read.** A query's `client.get` and `client.all` are watched; the
  driver behind `client.raw` is not, so a query that takes it is recorded with
  `unattributed: true`, and the persons of the rows it read there are not in `persons`.
- **Rows without their person.** A query that selects columns with SQL and leaves out the
  `person` column reads rows that name no one.
- **Read models without personal fields.** A query of one is not recorded, even when its rows
  hold a person's id: an id alone is what every event already carries.
- **The global stream.** `app.events.read()` hands out events as stored, personal fields
  encrypted, so it opens nothing and is not recorded; what decrypts them, such as a projection,
  is the runtime's own work.
- **What a policy sends out.** A port that mails a person their data, or a search index, records
  what it does itself.

## What it does get

What a production app does get, and where it is explained:
[rebuilding a read model](/guides/deployment/#rebuilding-a-read-model) without taking it offline,
[forgetting a person](/guides/personal-data/) without deleting an event,
[exporting their data](/guides/personal-data/#exporting-a-persons-data), read models included,
[recording who opened it](/guides/personal-data/#who-opened-what) and
[restricting their processing](/guides/personal-data/#restricting-processing) without losing a
reaction, [forgetting them](/guides/personal-data/#retention) after a retention or when a purpose
ends, their keys [wrapped under a master key](/guides/personal-data/#a-master-key) kept out of
the database, their forgetting [applied again](/guides/personal-data/#backups) when a backup is
restored,
[dead letters with a way out](/guides/dead-letters/), [upcasters](/guides/changing-events/) for
events whose payload changed, [snapshots](/concepts/long-streams/#snapshots) whose validity the
runtime checks itself, [observability](/reference/observability/) through OpenTelemetry, and a
dispatcher that reacts in milliseconds on PostgreSQL.
