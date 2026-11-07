---
title: Observability
description: The OpenTelemetry spans and metrics Bounda reports, and what to alert on.
sidebar:
  order: 4
---

The runtime is instrumented with the
[OpenTelemetry API](https://opentelemetry.io/docs/languages/js/). Without an SDK registered that
costs nothing: the API hands out no-op spans and meters. Register one and Bounda's spans and metrics
show up next to your HTTP server's and your database driver's, with no adapter to write:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter() });
sdk.start();

const app = await boot(); // after the SDK, so its instruments bind to the provider
```

Everything is reported under the scope `@bounda-dev/core`. Spans:

| Span | When | Attributes |
| --- | --- | --- |
| `bounda.command <Type>` | a command is dispatched | `bounda.command.type`, `bounda.aggregate.type`, `bounda.aggregate.id`, `bounda.correlation_id`, `bounda.causation_id`, `bounda.actor` when [someone acts](/concepts/ids-causation-and-correlation/#who-acts), `bounda.outcome` (`stored`, `scheduled`, `rejected`, or `replayed` for a dispatch answered from its `idempotencyKey`), `bounda.event.count`; a rejection adds the event `bounda.command.rejected`, its code in `bounda.rejected`, replayed or not; [how it loaded its aggregate](#how-a-command-loaded-its-aggregate) |
| `bounda.subscriber <name>` | the dispatcher hands a batch to a projection, the policy runner, the process runner, a snapshot subscriber, the retention or the forget ledger's copy; idle passes produce none | `bounda.subscriber`, `bounda.subscriber.kind` (`projection`, `policy`, `process`, `snapshot`, `retention`, `forget-ledger`), `bounda.position.after`, `bounda.event.count`, `bounda.outcome` (`advanced`, `held`, `failed`, `moved`); a snapshot subscriber that wrote snapshots adds `bounda.snapshot.version`, the highest version it wrote, and one event `bounda.snapshot.written` per snapshot, with `bounda.aggregate.id` and `bounda.snapshot.version` |
| `bounda.projection <readModel>.<projection>` | a projection handles one event | `bounda.read_model`, `bounda.projection`, the event's id, type and aggregate, `bounda.correlation_id` |
| `bounda.policy <aggregate>.<policy>` | a policy handler runs | `bounda.policy`, the event's id, type and aggregate, `bounda.correlation_id`, `bounda.attempt` |
| `bounda.process <aggregate>.<process>` | a process handler runs; `… at <field>` for an `at-<field>.ts`, `… at timeout` for `at-timeout.ts` | `bounda.process`, the event's id, type and aggregate, `bounda.correlation_id`, `bounda.attempt`; for a deadline, `bounda.process`, the process's aggregate type and id and `bounda.correlation_id` |
| `bounda.scheduled <Type>` | the worker runs a due command or a process deadline (`bounda.ProcessDeadline`) | `bounda.command.type`, `bounda.aggregate.id`, `bounda.correlation_id`, `bounda.attempt` |

A handler that throws marks its span as an error with the message and records the exception. A
command's rejection is an answer, not an error: its span keeps an unset status.

One request is not one trace. A policy runs in a later dispatcher pass, in whatever process picks
it up, so the command's span and the policy's span are separate traces. What ties them together is
`bounda.correlation_id`: the command, the events it stored, the policy that reacted and the
command it dispatched all carry the same value, so a search on that attribute shows the chain.

Metrics:

| Metric | Kind | Attributes |
| --- | --- | --- |
| `bounda.dispatcher.lag` | observable gauge, events each subscriber is behind the head | `bounda.subscriber` |
| `bounda.commands` | counter | `bounda.command.type`, `bounda.outcome` (`stored`, `scheduled`, `rejected`, `replayed`, `failed`) |
| `bounda.dead_letters` | counter | `bounda.handler.kind`, `bounda.handler`, `bounda.outcome` (`terminal`, `retriable_exhausted`) |
| `bounda.snapshots` | counter, loads of an aggregate with [snapshots](/concepts/long-streams/#snapshots) | `bounda.aggregate.type`, `bounda.outcome` (`used`, `verified`, `mismatch`, `missing`, `stale`, `unreadable`, `ahead`) |
| `bounda.fold.events` | histogram, events folded into an aggregate's state per load, by commands and snapshot subscribers | `bounda.aggregate.type` |

The lag gauge is what to alert on: a subscriber whose lag grows is a projection or a policy that is
failing or stuck, and `app.getLag()` returns the same numbers for a health endpoint, with what a
failing subscriber is stuck on (see
[A projection that keeps failing](/guides/deployment/#a-projection-that-keeps-failing)). A
`mismatch` on `bounda.snapshots` is worth one too: a snapshot folded to a state the stream does not
give, so an `evolve` of that aggregate depends on something other than the events.

## How a command loaded its aggregate

A `bounda.command` span that loaded its aggregate says how, once it ends, whatever the outcome:

| Attribute | What it holds |
| --- | --- |
| `bounda.aggregate.version` | the stream's version the load reached, the one the append expects |
| `bounda.fold.events` | the events folded into the state: those after the snapshot when one was used, the whole stream otherwise |
| `bounda.snapshot.outcome` | only for an aggregate with [snapshots](/concepts/long-streams/#snapshots): what its snapshot was worth, the same values as the `bounda.snapshots` counter |
| `bounda.snapshot.version` | only when the snapshot was used (`used` or `verified`): the version the state was loaded from |

A command retried after a concurrency conflict reports its last load. A scheduled command loads
nothing until the worker runs it, and a dispatch answered from its `idempotencyKey` (`replayed`)
loads nothing either, so their spans carry none of these. The dispatch result never says how the
aggregate was loaded: a replay returns what the first dispatch returned, and a snapshot stays a
cache nobody has to know about. To read these attributes in a test or a demo, register an
in-memory span exporter, such as `InMemorySpanExporter` from `@opentelemetry/sdk-trace-base`.
