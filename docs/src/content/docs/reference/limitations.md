---
title: What is not there yet
description: What a production app might want from Bounda and does not get today, and why.
sidebar:
  order: 5
---

Bounda is 0.x, and this is the honest list of what a production app might want and does not
get today. Each item says why, so nobody discovers it the hard way:

- **Snapshots.** An aggregate is folded from its whole stream on every command. That is fine for
  the hundreds of events per instance that Bounda's kind of app produces, and it is not fine for
  hundreds of thousands. Snapshots are deliberately not built yet: the state is inferred and
  carries no version, so a snapshot written by yesterday's `evolve` would silently be wrong after
  today's deploy. They come with a versioning story or not at all; until then, close the books
  of an aggregate that would grow forever ([Long streams](/concepts/long-streams/)).
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

What a production app does get, and where it is explained:
[rebuilding a read model](/guides/deployment/#rebuilding-a-read-model) without taking it offline,
[dead letters with a way out](/guides/dead-letters/), [upcasters](/guides/changing-events/) for
events whose payload changed, [observability](/reference/observability/) through OpenTelemetry, and
a dispatcher that reacts in milliseconds on PostgreSQL.
