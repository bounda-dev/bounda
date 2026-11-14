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
  state, the `after` and `limit` of a [read of the global stream](/guides/reading-the-stream/),
  the actor given to [`as`](/concepts/ids-causation-and-correlation/#who-acts), or what
  [`redact`](/guides/personal-data/#correcting-a-persons-data) was given, an event the store does
  not hold, that does not name the person, or a field its type does not mark `personal`, did not
  validate. `issues` lists each problem with its `path`.
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
- **`PROCESSING_RESTRICTED`** (`ProcessingRestrictedError`; terminal). Work would process data a
  [restriction](/guides/personal-data/#restricting-processing) covers, on no basis that opens it:
  a command that touches a person restricted as a whole, the one its payload names with `person`
  or whose aggregate is the person, or whose aggregate's events hold data a restriction covers,
  refused before its handler runs; one restricted while it ran, or whose events seal a field of a
  restricted category, refused as its events are appended; a policy, process step or scheduled
  command on such data, before its handler runs. Nothing is stored and nothing is recorded.
  `personId`. A reaction's letter with this code is retried by the runtime once `unrestrict` lifts
  the restriction; `processRestricted`, or `restricted` in a policy or process, names the basis that
  lets the work through.
- **`CREATION_ORDER`** (`CreationOrderError`; terminal). A command returned events that do not fit
  whether its aggregate exists: the first event is not one that exports `begin`, or an event that
  only exports `begin` goes on an aggregate that exists. Nothing is stored.
- **`NOT_FOUND`** (`NotFoundError`; terminal). An unknown command or query, or a requested row or
  registry entry that does not exist.
- **`INVALID_CONFIGURATION`** (`ConfigurationError`; terminal). `bounda.config.ts` or the registry
  is malformed: an unknown key, a port with no implementation chosen, a module missing an export.
  Thrown at boot, or when a handler reads a port a test left out. Also thrown at start by a
  database whose Bounda tables a version before 0.2.0 created.
- **`FORGET_LEDGER_UNAVAILABLE`** (`ForgetLedgerUnavailableError`; a forgetting's answer). Thrown
  by `forget`, `forgetAgain`, `bounda forget` and a policy's or process's `forget` when
  `runtime.personalData.forgetLedger.strict` is set and the
  [forget ledger](/guides/personal-data/#what-the-runtime-does-with-it) did not take the
  forgetting's intention: nothing was forgotten, so trying again is safe. `cause` is the ledger's
  error, a `ForgetLedgerTimeoutError` when it did not answer in time.
- **`FORGET_LEDGER_TIMEOUT`** (`ForgetLedgerTimeoutError`, with `operation` and `timeoutMs`). A call
  to the forget ledger did not settle within `runtime.personalData.forgetLedger.timeout`: the
  `cause` of `FORGET_LEDGER_UNAVAILABLE` and `FORGET_LEDGER_UNRECONCILED`, and what an app that is
  not strict logs. The call may still land after it.
- **`FORGET_LEDGER_UNRECONCILED`** (`ForgetLedgerUnreconciledError`; a start's answer). Thrown
  by `createApp`, and so by `boot` and the CLI, when `runtime.personalData.forgetLedger.strict` is
  set and the [forget ledger](/guides/personal-data/#the-forget-ledger) could not be read through:
  the app does not start, since a person a restored backup brought back could be read. `cause` is
  the ledger's error. Starting again tries again.
- **`STORAGE_SCHEMA_TOO_NEW`** (`StorageSchemaTooNewError`; a start's answer). Thrown by
  `createApp`, and so by `boot` and the CLI, and by `migrateTables` and `bounda migrate`, when a newer version of Bounda has
  [migrated the database's Bounda tables](/guides/deployment/#schema) past what this version
  knows: `scope` (`storage`, `checkpoints` or `forget-ledger`), its `version`, and `supported`,
  the newest this version knows. The app does not start and nothing is written: Bounda never takes
  a schema back. Run that version or a later one, or restore a backup taken before it migrated.
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
| `HANDLER_TIMEOUT` | 504 | rethrown |
| anything else | 500, code `INTERNAL`, logged | rethrown, for the route's `ErrorBoundary` |

`createWorker` answers with `{ error: { code, message } }`, and 400 with `INVALID_JSON` for a
body it cannot parse. `failure()` goes by the code too, so it answers the same whether the app runs
in the process or in a Durable Object, whose refusals arrive as plain errors. See
[errors from the domain](/guides/react-router/#errors-from-the-domain) and
[the Cloudflare adapter](/adapters/cloudflare/).
