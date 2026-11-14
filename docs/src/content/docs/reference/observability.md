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
| `bounda.projection <readModel>.<projection>` | a projection handles one event | `bounda.read_model`, `bounda.projection`, the event's id, type and aggregate, `bounda.correlation_id`, `bounda.actor` when the event names one |
| `bounda.policy <aggregate>.<policy>` | a policy handler runs | `bounda.policy`, the event's id, type and aggregate, `bounda.correlation_id`, `bounda.attempt`, `bounda.actor`: the event's, or whoever retries its dead letter |
| `bounda.process <aggregate>.<process>` | a process handler runs; `… at <field>` for an `at-<field>.ts`, `… at timeout` for `at-timeout.ts` | `bounda.process`, the event's id, type and aggregate, `bounda.correlation_id`, `bounda.attempt`; for a deadline, `bounda.process`, the process's aggregate type and id and `bounda.correlation_id`; `bounda.actor` as for a policy, or that of what set the deadline |
| `bounda.scheduled <Type>` | the worker runs a due command or a process deadline (`bounda.ProcessDeadline`) | `bounda.command.type`, `bounda.aggregate.id`, `bounda.correlation_id`, `bounda.attempt`, `bounda.actor` of whoever scheduled it |
| `bounda.query <Type>` | a query runs, and each one it composes | `bounda.query.type`, `bounda.read_model`, `bounda.actor` |
| `bounda.backfill` | the worker seals a batch of events written before the [personal data marks](/guides/personal-data/#marking-a-field-later) of now | `bounda.position.after`, `bounda.event.count` |
| `bounda.operation <operation>` | the client runs `forget`, `restrict`, `unrestrict`, `redact`, `exportPersonalData`, `rebuildReadModel`, or `deadLetters.list`, `count`, `get`, `retry` or `discard` | `bounda.operation`, as named here, `bounda.actor` |

`bounda.actor` is there only when [someone acts](/concepts/ids-causation-and-correlation/#who-acts):
a client bound with `as`, and what follows from it. A handler, a query or an operation that throws
marks its span as an error, sets `error.type` to the error's class and adds an `exception` event
with `exception.type` and, for a `BoundaError`, `bounda.error.code`; what it says of the error's
text is [below](#error-text). A command's rejection is an answer, not an error: its span keeps an
unset status.

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

## Error text

The message of an error a handler throws may quote what it read, a person's email included, and a
tracing backend or a log pipeline keeps it in the clear, where `forget` never reaches. So by
default no span and no log line of the runtime carries the text of an error:

- a failed span's status says `ValidationError (VALIDATION_FAILED)`, its class and code, and its
  `exception` event has neither `exception.message` nor `exception.stacktrace`;
- a log line names the error with `errorName` and, for a `BoundaError`, `errorCode`, next to the
  ids of what failed: the event, the command, the subscriber;
- `app.getLag()` says what a failing subscriber is stuck on with `errorName` and `errorCode`, and
  `app.status()` (and `bounda status`) its last failure, by any instance, with the same identity.

An error whose message Bounda writes from names and ids alone, such as `ConcurrencyError`,
`ClaimLostError`, `HandlerTimeoutError` or a dead letter not found, keeps its message, never its
stack. To find out what a reaction failed on, follow the log line that filed its dead letter:
`policy dead-lettered`, `process dead-lettered` and `scheduled command dropped` carry `letterId`,
and `app.deadLetters.get(letterId)` opens the text the letter keeps encrypted under the person
(see [what a letter holds](/guides/dead-letters/#what-a-letter-holds)). A projection has no
letter: its batch is delivered again until it goes through, so the runtime keeps the last failure
of each subscriber instead, its text encrypted under the person the event names, or in the clear
for an event that names nobody, whatever `errorText` says. `app.subscriberFailures.list()` and
`.get(subscriber)`, or `bounda status --error-text`, open it, and each call is recorded in the
[access log](/guides/personal-data/#the-access-log); once the person is forgotten it reads `null`.
Your own logger calls
around the app, in a request handler, can follow the same rule with `errorFields`:

```ts
import { errorFields } from "@bounda-dev/core";

logger.error("request failed", { path, ...errorFields({ error }) });
```

A React Router app exports Bounda's `handleError` from `app/entry.server.tsx`, which logs what a
loader, an action or the render throws by the same rule: React Router's default logs every message
and stack, in production too (see [logging errors](/guides/react-router/#logging-errors)).

[`runtime.telemetry.errorText: "include"`](/reference/configuration/#telemetry) adds the message
and the stack everywhere: `errorMessage` and `errorStack` in log lines, `exception.message` and
`exception.stacktrace` on spans, the message as a failed span's status and `errorMessage` in the
lag. It is for development: `createTestApp` and the dev server of `@bounda-dev/react-router`
default to it unless the configuration says otherwise, `bounda --error-text` turns it on for one
command, and the logger handed to port implementations follows it too.

The environment variable `BOUNDA_ERROR_TEXT`, `"omit"` or `"include"`, sets it for a deployment
without touching the configuration, which on Cloudflare is the same bundle everywhere: `boot()`,
the CLI, and the Durable Object and the Worker of `@bounda-dev/cloudflare` read it, over what the
configuration says. `bounda --error-text` and `boot({ errorText })` still win over it, and any
other value fails the boot with `ConfigurationError`. Projects from `create-bounda` on Cloudflare
set it in `.dev.vars`, which `wrangler dev` and `vite dev` read and a deployment never sees; the
constant `ERROR_TEXT_VARIABLE` from `@bounda-dev/core` names it.

Every host resolves the rule with the same precedence: its own override, then `BOUNDA_ERROR_TEXT`,
then the configuration, then the host's own default (the dev server's `"include"`), then
`"omit"`. A host of your own resolves it the same way with `resolveErrorText` from
`@bounda-dev/core`, and `withErrorText` returns the configuration with it applied:

```ts
import { withErrorText } from "@bounda-dev/core";

const app = await createApp({ registry, config: withErrorText({ config, env: process.env }) });
```

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

## Who opened personal data

Who opened whose personal data is not in a span. A tracing backend samples, and drops spans under
load, which is right for latency and wrong for an audit trail, where one missing entry is a
read nobody can account for. The [access log](/guides/personal-data/#who-opened-what) is
delivered on its own: to `app/audit.ts` when the project has one, else to the app's logger at
`info` with the message `personal data accessed`, never sampled, and a hook that fails fails the
read. Spans carry `bounda.actor` to find the work of one actor in a trace, not to account for it:
the event store records who acted on every command and event, and the access log who read.
