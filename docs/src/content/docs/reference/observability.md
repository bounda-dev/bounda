---
title: Observability
description: The OpenTelemetry spans and metrics Bounda reports, and what to alert on.
sidebar:
  order: 4
---

The runtime is instrumented with the [OpenTelemetry API](https://opentelemetry.io/docs/languages/js/).
Without an SDK registered that costs nothing: the API hands out no-op spans and meters. Register
one and Bounda's spans and metrics show up next to your HTTP server's and your database
driver's, with no adapter to write:

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
| `bounda.command <Type>` | a command is dispatched | `bounda.command.type`, `bounda.aggregate.type`, `bounda.aggregate.id`, `bounda.correlation_id`, `bounda.causation_id`, `bounda.outcome` (`stored`, `scheduled`, `rejected`), `bounda.event.count`; a rejection adds the event `bounda.command.rejected`, its code in `bounda.rejected` |
| `bounda.subscriber <name>` | the dispatcher hands a batch to a projection, the policy runner or the process runner; idle passes produce none | `bounda.subscriber`, `bounda.subscriber.kind`, `bounda.position.after`, `bounda.event.count`, `bounda.outcome` (`advanced`, `held`, `failed`, `moved`) |
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
| `bounda.commands` | counter | `bounda.command.type`, `bounda.outcome` (`stored`, `scheduled`, `rejected`, `failed`) |
| `bounda.dead_letters` | counter | `bounda.handler.kind`, `bounda.handler`, `bounda.outcome` (`terminal`, `retriable_exhausted`) |

The lag gauge is what to alert on: a subscriber whose lag grows is a projection or a policy that
is failing or stuck, and `app.getLag()` returns the same numbers for a health endpoint, with what
a failing subscriber is stuck on (see [A projection that keeps failing](/guides/deployment/#a-projection-that-keeps-failing)).
