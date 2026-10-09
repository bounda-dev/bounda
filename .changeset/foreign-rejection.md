---
"@bounda-dev/core": minor
---

A `DomainError` that a command handler lets through without making it with its own `reject`, such
as one rethrown from another app's command, now fails the command with a `BoundaError` coded
`FOREIGN_REJECTION`, with that `DomainError` as its `cause`. `app.commands` used to throw the other
command's `DomainError` as it was, so a caller could not tell it from this command's rejection:
`failure()` from `@bounda-dev/react-router` answered it with a 409 and a code the command does not
declare, and `createWorker` from `@bounda-dev/adapter-cloudflare` with a 409 too. Now the first
rethrows it for the route's `ErrorBoundary` and the second answers a 500. A reaction fails with it
as before, and dead-letters it at once.
