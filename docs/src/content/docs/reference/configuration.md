---
title: Configuration
description: Every key of bounda.config.ts, what it does and its default.
sidebar:
  order: 1
---

`bounda.config.ts` exports `defineConfig({...})` from `@bounda-dev/core/config`. `boot()` reads it,
and `createApp` takes the same object; `createTestApp` does not read it. The configuration is
checked when the app is created: an unknown key, a value of the wrong type or a duration it cannot
read throws a `ConfigurationError` that lists every problem with its path.

```ts
import { postgresql } from "@bounda-dev/adapter-postgresql";
import { defineConfig } from "@bounda-dev/core/config";

export default defineConfig({
  storage: postgresql({ url: process.env.DATABASE_URL! }),
  ports: { order: { notifier: "smtp" } },
  runtime: { role: "worker", policies: { timeout: "1m" } },
});
```

**Durations** are a number of milliseconds or a string: a number followed by `ms`, `s`, `m`, `h`
or `d` (`"250ms"`, `"1.5s"`, `"7d"`). A duration read from the environment is a `string`, which the
types refuse; wrap it with `asDuration(process.env.X ?? "1m")`, which checks it.

## Top level

- **`storage`**, required. The adapter that holds the store: `sqlite({...})`, `postgresql({...})` or
  `cloudflare()`. See [adapters](/adapters/).
- **`readModels`**, default `{}`. A different adapter for some read models, by read model name: `{
  orderSummary: postgresql({ url: READ_URL }) }`. The rest stay in `storage`.
- **`ports`**, default `{}`. The implementation each port uses, by module and port: `{ order: {
  notifier: "smtp" } }`. A port with one implementation may be left out; one with several must be
  named. The names are typed from the project. See [ports](/guides/project-layout/#ports-portts).
- **`runtime`**. How the app runs.

## `runtime`

- **`role`**, default `"all"`. What `app.start()` runs in this process: `"all"` and `"worker"` run
  the dispatcher and the scheduled-command worker, `"web"` runs neither. See
  [roles](/guides/deployment/#roles).

### Commands

- **`commands.timeout`**, default `"30s"`. How long one run of a command handler may take. Past it
  the dispatch rejects with `HANDLER_TIMEOUT`, the handler's `signal` aborts and nothing it returns
  is stored. Loading the aggregate and storing its events do not count.
- **`commands.concurrencyRetries`**, default `3`. How many times a command runs again when its
  append finds the stream moved, before a `ConcurrencyError` reaches the caller. Each run gets its
  own `timeout`.

### Policies

- **`policies.timeout`**, default `"30s"`. How long one run of a policy handler may take. Past it
  the run is abandoned: its commands still running stop, later ones are refused with
  `REACTION_ABANDONED`, and its `signal` aborts.
- **`policies.retry`**, default exponential, 3 attempts, 1 s to 30 s. How a failed policy run, or
  a failed command scheduled with `delay`, is retried. Under `overrides`, a policy run takes the
  setting of the aggregate the policy belongs to, and a scheduled command that of the aggregate it
  is for. See [retry](#retry).
- **`policies.maxChainDepth`**, default `25`. How many hops a chain of reactions may take from the
  command that started it before a command is refused with `CHAIN_DEPTH_EXCEEDED`. Reaching it
  usually means two policies answer each other.

### Processes

- **`processes.timeout`**, default `"7d"`. How long a process stays open before `at-timeout.ts`
  runs, for a process whose `config` declares no `timeout`.
- **`processes.handlerTimeout`**, default `"30s"`. How long one run of a process handler, for an
  event or a deadline, may take. Past it the run is abandoned, as a policy's is.
- **`processes.retry`**, default the same as `policies.retry`'s, not what `policies.retry` is set
  to. How a failed process step or deadline is retried.

Each time limit also decides how long a claim lasts, so how soon another instance runs again what
a stopped one left: see [delivery guarantees](/concepts/delivery-guarantees/#the-inbox-handled-once-by-the-store).

### Dispatcher

- **`dispatcher.pollInterval`**, default `"100ms"`. How long the dispatcher waits between passes
  when it polls, and the pace of the scheduled-command worker.
- **`dispatcher.idleInterval`**, default `"30s"`. With an adapter that pushes notifications
  (PostgreSQL), how long an idle dispatcher waits for one before polling anyway. Ignored without
  notifications.
- **`dispatcher.batchSize`**, default `100`. Events read per subscriber per pass.
- **`dispatcher.projectionBatchTime`**, default `"250ms"`. How long a projection batch keeps its
  transaction open before it commits what it has and leaves the rest for the next one. Rebuilds
  honour it.
- **`dispatcher.backoff.baseDelay`, `.maxDelay`**, default `"1s"`, `"30s"`. How long background
  passes leave a subscriber alone after a failed batch: `baseDelay` after the first failure,
  doubling up to `maxDelay`. A batch that goes through resets it. See
  [a projection that keeps failing](/guides/deployment/#a-projection-that-keeps-failing).
- **`dispatcher.catchUp.timeout`, `.pollInterval`**, default `"2s"`, `"15ms"`. How long
  `catchUpReadModels({ through })`, and read-your-writes with it, waits for the read models a
  command changed, and how often it looks while another process holds them. Past `timeout` it logs a
  warning and the request reads what is there.

### Per aggregate

- **`overrides`**, default `{}`. Settings for one aggregate, by aggregate name: `commands.timeout`,
  and `policies` and `processes` with the keys above. What an override leaves out comes from the
  app's settings.

A process can set its own lifetime in its `config`,
`({ events }) => ({ startedBy: [...], timeout: "48h" })`, which wins over `processes.timeout` and
over an override.

## `retry`

`policies.retry` and `processes.retry` take the same shape. `strategy` is required whenever
`retry` is given; the other keys fall back to the defaults.

| Key | Default | What it does |
| --- | --- | --- |
| `strategy` | `"exponential"` | `"none"` gives up on the first failure; `"fixed"` waits `baseDelay` each time; `"linear"` waits `baseDelay` times the retry number; `"exponential"` doubles `baseDelay` with each retry. |
| `maxAttempts` | `3` | Runs in all, the first one included, before the failure becomes a dead letter. |
| `baseDelay` | `"1s"` | The first wait. |
| `maxDelay` | `"30s"` | No wait is longer than this. |

Only failures that may pass are retried. A rejection is an answer, not a failure; a payload that
does not validate, a missing module, a broken configuration, a chain that went too deep or events
that do not fit the aggregate (`VALIDATION_FAILED`, `NOT_FOUND`, `INVALID_CONFIGURATION`,
`CHAIN_DEPTH_EXCEEDED`, `CREATION_ORDER`) become a dead letter at once, since they would fail the
same way again. See [errors](/reference/errors/).

```ts
runtime: {
  policies: { retry: { strategy: "exponential", maxAttempts: 5, maxDelay: "2m" } },
  overrides: {
    // a policy whose command can never succeed on a second try; the commands scheduled for
    // `order` are not retried either
    order: { policies: { retry: { strategy: "none" } } },
  },
},
```

## Outside `bounda.config.ts`

- **React Router**: the `bounda()` Vite plugin takes `consistency` and `debounceMs`; see
  [its options](/guides/react-router/#options).
- **Cloudflare**: `createBoundaObject` takes `passesPerAlarm`, and `connect` and `createWorker`
  take `consistency`; see [the Cloudflare adapter](/adapters/cloudflare/#how-it-runs).
- **Tests**: `createTestApp` takes its own `ports` and `config`; see [testing](/guides/testing/).
