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
  `rejected` holds the code. `app.commands` throws it; a reaction gets it as a value instead, and
  only a `DomainError` the handler did not make with its own `reject` fails a reaction.
- **`VALIDATION_FAILED`** (`ValidationError`; terminal). A payload, a duration or a returned process
  state did not validate. `issues` lists each problem with its `path`.
- **`CONCURRENCY_CONFLICT`** (`ConcurrencyError`; retried). An append found the stream at another
  version, after `runtime.commands.concurrencyRetries` runs of the command. `streamId`,
  `expectedVersion`, `actualVersion`.
- **`HANDLER_TIMEOUT`** (no exported class; retried). A command, policy or process handler ran out
  of time (`runtime.commands.timeout`, `runtime.policies.timeout`).
- **`REACTION_ABANDONED`** (no exported class; the run already failed). A command a reaction
  dispatched after its run was abandoned, or that was still running then. `cause` is why the run was
  abandoned.
- **`REACTION_FINISHED`** (no exported class; the run already ended). A command a reaction
  dispatched after its run had finished, from a timer or a promise it left behind. Dispatch while
  the handler runs.
- **`CHAIN_DEPTH_EXCEEDED`** (`ChainDepthExceededError`; terminal). A chain of reactions went deeper
  than `runtime.policies.maxChainDepth`. `depth`, `maxDepth`.
- **`CREATION_ORDER`** (`CreationOrderError`; terminal). A command returned events that do not fit
  whether its aggregate exists: the first event is not one that exports `begin`, or an event that
  only exports `begin` goes on an aggregate that exists. Nothing is stored.
- **`NOT_FOUND`** (`NotFoundError`; terminal). An unknown command or query, or a requested row or
  registry entry that does not exist.
- **`INVALID_CONFIGURATION`** (`ConfigurationError`; terminal). `bounda.config.ts` or the registry
  is malformed: an unknown key, a port with no implementation chosen, a module missing an export.
  Thrown at boot, or when a handler reads a port a test left out.
- **`CLAIM_LOST`** (`ClaimLostError`; handled by the runtime). A reaction's inbox claim expired and
  another instance took it over. The attempt writes nothing; the other instance's run is the one
  that counts.
- **`SCHEDULED_CLAIM_LOST`** (`ScheduledClaimLostError`; handled by the runtime). The same for a
  scheduled command, a delayed policy run or a deadline, or the command was cancelled.
- **`DEAD_LETTER_SETTLED`** (`DeadLetterSettledError`; an operator's answer). A dead letter was
  retried or discarded after another retry or discard had settled it.
- **`DEAD_LETTER_NOT_RETRIABLE`** (`DeadLetterNotRetriableError`; an operator's answer). A dead
  letter cannot be retried in the app as it is now: its handler is gone or no longer handles the
  event, or its process failed on another step first. The letter stays `failed`.
- **`REBUILD_SUPERSEDED`** (`RebuildSupersededError`; an operator's answer). Another rebuild of the
  same read model took over; this one stopped without writing. `readModel`.

The last three are answers to an operator, from `app.deadLetters`, `bounda dead-letters` and
`bounda rebuild`, not failures of a handler.

## Over HTTP

The hosts map the codes a client can cause to a status:

| Code | `createWorker` (Cloudflare) | `failure()` (React Router) |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400, with `issues` | 400, with `issues` |
| `DOMAIN_ERROR` | 409, with `rejected` | 409, with `rejected` |
| `CONCURRENCY_CONFLICT` | 409 | rethrown |
| `CHAIN_DEPTH_EXCEEDED` | 409 | rethrown |
| `NOT_FOUND` | 404 | rethrown |
| `HANDLER_TIMEOUT` | 504 | rethrown |
| anything else | 500, code `INTERNAL`, logged | rethrown, for the route's `ErrorBoundary` |

`createWorker` answers with `{ error: { code, message } }`, and 400 with `INVALID_JSON` for a
body it cannot parse. See
[errors from the domain](/guides/react-router/#errors-from-the-domain) and
[the Cloudflare adapter](/adapters/cloudflare/).
