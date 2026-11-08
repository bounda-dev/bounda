---
title: Errors
description: Every error Bounda throws, its stable code, who sees it and whether a reaction retries it.
sidebar:
  order: 3
---

Every error Bounda throws extends `BoundaError`, exported from `@bounda-dev/core`, and carries a
`code` that stays the same across versions. Branch on `code`, or on the class where it is
exported; the `message` is for people and can change.

```ts
import { BoundaError } from "@bounda-dev/core";

try {
  await app.commands.placeOrder(payload);
} catch (error) {
  if (error instanceof BoundaError && error.code === "VALIDATION_FAILED") {
    // show the issues
  }
  throw error;
}
```

## Codes

**Terminal** means a policy, process or scheduled command that fails with it becomes a dead letter
at once, with `errorType: "terminal"`, since it would fail the same way again. Anything else is
retried by the [retry settings](/reference/configuration/#retry) and, when they run out, becomes a
dead letter with `errorType: "retriable_exhausted"`.

- **`DOMAIN_ERROR`** (`DomainError`; terminal). A command handler rejected with `reject(code)`.
  `rejected` holds the code. `app.commands` throws it; a reaction gets it as a value instead.
- **`FOREIGN_REJECTION`** (no exported class; terminal). A command handler let through a
  `DomainError` it did not make with its own `reject`, such as one rethrown from another app's
  command. The command fails rather than rejects, so `app.commands` and a reaction both get this
  error, never the other command's code. `cause` is that `DomainError`.
- **`VALIDATION_FAILED`** (`ValidationError`; terminal). A payload, a duration, a returned process
  state, the `after` and `limit` of a [read of the global stream](/guides/reading-the-stream/) or
  the actor given to [`as`](/concepts/ids-causation-and-correlation/#who-acts) did not validate. `issues` lists each problem with its `path`.
- **`CONCURRENCY_CONFLICT`** (`ConcurrencyError`; retried). An append found the stream at another
  version, or, with both versions equal, a person whose [personal data](/guides/personal-data/)
  the command loaded, or whose fields its events seal, was forgotten before the append committed,
  whether or not they hold a new key by then; after `runtime.commands.concurrencyRetries` runs of
  the command. `streamId`, `expectedVersion`, `actualVersion`.
- **`HANDLER_TIMEOUT`** (no exported class; retried). A command, policy or process handler ran out
  of time (`runtime.commands.timeout`, `runtime.policies.timeout`,
  `runtime.processes.handlerTimeout`).
- **`REACTION_ABANDONED`** (no exported class; the run already failed). A command a reaction
  dispatched after its run was abandoned, or that was still running then. `cause` is why the run was
  abandoned.
- **`REACTION_FINISHED`** (no exported class; the run already ended). A command a reaction
  dispatched, or a `forget` it called, after its run had finished, from a timer or a promise it
  left behind. Dispatch and forget while the handler runs.
- **`CHAIN_DEPTH_EXCEEDED`** (`ChainDepthExceededError`; terminal). A chain of reactions went deeper
  than `runtime.policies.maxChainDepth`, by a command or by a `forget` a policy or process called.
  `depth`, `maxDepth`.
- **`IDEMPOTENCY_KEY_CONFLICT`** (`IdempotencyKeyConflictError`; terminal). A dispatch's
  `idempotencyKey` was already used, within `runtime.commands.idempotencyKeyLifetime`, for
  another command or for the same command with another payload or `delay`. Nothing runs.
  `idempotencyKey`.
  See [idempotent commands](/guides/idempotent-commands/).
- **`PROCESSING_RESTRICTED`** (`ProcessingRestrictedError`; terminal). A command touches a person
  whose [processing is restricted](/guides/personal-data/#restricting-processing): the one its
  payload names with `person`, or whose aggregate is the person, refused before it runs; or one
  restricted while it ran, or whose fields its events seal, refused as its events are appended.
  Nothing is stored and nothing is recorded. `personId`. A reaction's letter with this code is retried by the runtime once
  `unrestrict` lifts the restriction.
- **`CREATION_ORDER`** (`CreationOrderError`; terminal). A command returned events that do not fit
  whether its aggregate exists: the first event is not one that exports `begin`, or an event that
  only exports `begin` goes on an aggregate that exists. Nothing is stored.
- **`NOT_FOUND`** (`NotFoundError`; terminal). An unknown command or query, or a requested row or
  registry entry that does not exist.
- **`INVALID_CONFIGURATION`** (`ConfigurationError`; terminal). `bounda.config.ts` or the registry
  is malformed: an unknown key, a port with no implementation chosen, a module missing an export.
  Thrown at boot, or when a handler reads a port a test left out. Boot and `bounda rebuild` also
  throw it for a store holding events the code cannot read: of a type, aggregate or process it no
  longer has, or written with a schema version past the one it knows
  ([Deploying a change to events](/guides/deployment/#deploying-a-change-to-events)).
- **`SCHEMA_AHEAD`** (`SchemaAheadError`; held, never dead-lettered). An event newer code wrote,
  while a deploy rolls out: its schema version is past the one this code knows, or its type is
  one this code has no module for although the store's catalogue records it. `eventId`,
  `aggregateType`, `aggregateId`, `type`, `position`, `schemaVersion`, and `known`, the version
  this code reads up to, `null` for a type it lacks. A command that loads such a stream fails with
  it. A policy or process holds the event and retries with its back-off past `maxAttempts`, never
  giving up on it; each retry still counts as an attempt of its claim. A scheduled command waits
  `runtime.dispatcher.backoff.baseDelay` without counting one, a read model stops right before the
  event, and a dead-letter retry rejects with it, leaving the letter `failed`. It goes away once
  that code runs on every instance; roll forward, never back.
- **`CLAIM_LOST`** (`ClaimLostError`; handled by the runtime). A reaction's inbox claim expired and
  another instance took it over. The attempt writes nothing; the other instance's run is the one
  that counts.
- **`SCHEDULED_CLAIM_LOST`** (`ScheduledClaimLostError`; handled by the runtime). The same for a
  scheduled command, a delayed policy run or a deadline, or the command was cancelled.
- **`IDEMPOTENCY_KEY_TAKEN`** (`IdempotencyKeyTakenError`; handled by the runtime). Of two
  dispatches racing for one `idempotencyKey`, the one that lost: what it stored rolls back, and it
  answers what the key holds.
- **`DEAD_LETTER_SETTLED`** (`DeadLetterSettledError`; an operator's answer). A dead letter was
  retried or discarded after another retry or discard had settled it.
- **`DEAD_LETTER_NOT_RETRIABLE`** (`DeadLetterNotRetriableError`; an operator's answer). A dead
  letter cannot be retried in the app as it is now: its handler is gone or no longer handles the
  event, its process failed on another step first, or the person whose data its scheduled command
  holds was forgotten since. The letter stays `failed`.
- **`REBUILD_SUPERSEDED`** (`RebuildSupersededError`; an operator's answer). Another rebuild of the
  same read model took over; this one stopped without writing. `readModel`.
- **`SNAPSHOT_FAILED`** (`SnapshotError`; only in an app from `createTestApp`). A
  [snapshot](/concepts/long-streams/#snapshots) did not stand for its stream: the state folded from
  it differs from the one folded from the first event, or the state cannot be serialized. Thrown by
  the command that loaded it or by `runUntilIdle()`. Any other app logs it, drops the snapshot and
  folds the stream from the start.

The last three are answers to an operator, from `app.deadLetters`, `bounda dead-letters` and
`bounda rebuild`, not failures of a handler.

## Over HTTP

The hosts map the codes a client can cause to a status:

| Code | `createWorker` (Cloudflare) | `failure()` (React Router) |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400, with `issues` | 400, with `issues` |
| `DOMAIN_ERROR` | 409, with `rejected` | 409, with `rejected` |
| `PROCESSING_RESTRICTED` | 409 | 409 |
| `IDEMPOTENCY_KEY_CONFLICT` | 500, code `INTERNAL`, logged | 422 |
| `CONCURRENCY_CONFLICT` | 409 | rethrown |
| `CHAIN_DEPTH_EXCEEDED` | 409 | rethrown |
| `FOREIGN_REJECTION` | 500, code `INTERNAL`, logged | rethrown |
| `NOT_FOUND` | 404 | rethrown |
| `PAYLOAD_TOO_LARGE` | 413, a body over `maxPayloadBytes` | — |
| `SCHEMA_AHEAD` | 503 | 503 |
| `HANDLER_TIMEOUT` | 504 | rethrown |
| anything else | 500, code `INTERNAL`, logged | rethrown, for the route's `ErrorBoundary` |

`createWorker` answers with `{ error: { code, message } }`, and 400 with `INVALID_JSON` for a
body it cannot parse. `failure()` goes by the code too, so it answers the same whether the app runs
in the process or in a Durable Object, whose refusals arrive as plain errors. See
[errors from the domain](/guides/react-router/#errors-from-the-domain) and
[the Cloudflare adapter](/adapters/cloudflare/).
