---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"@bounda-dev/cloudflare": minor
"create-bounda": patch
---

A command declares how it may say no. Its module exports `rejections`, a function of the command
and the state the handler saw to `{ Code: message }`, and its handler returns `reject("Code")`, or
throws it: `reject` is in the handler's arguments only when the module exports `rejections`, and it
only takes those codes. It returns the `DomainError` the caller gets, which now carries the code in
`rejected`. A `DomainError` can no longer be built with `new`: its constructor takes a `Rejection`
only `reject` makes. The `+types` of every command gain `RejectionsArgs`.

In a policy or a process, `await commands.x()` resolves with the rejection instead of throwing it:
`rejected` is `false` when the aggregate decided, or the code, typed by what the command declares,
with its `message`, so compensating is `if (paid.rejected === "NotOpen")`, without `try/catch`. A
rejection the handler does not look at changes nothing and the run goes on; it is logged and
recorded on the command's span as the event `bounda.command.rejected`. Before, it failed the run
for good. A scheduled command that is rejected when it runs is no longer dead-lettered either, nor
recorded as `ScheduledCommandFailed`. The promise rejects only for a failure. Only what the command's own
`reject` made is a rejection: a `DomainError` from anywhere else, such as another app's command,
fails the command. A policy or process can no longer throw a `DomainError` to give up at once.
`runUntilIdle()` returns the rejections that happened while it ran, in `rejections`, for tests to
assert the ones they expect.

A policy or process run now waits for every command it dispatched before it commits, awaited or
not, within its time limit, and one that fails fails the run, even when the handler caught its
error; one the handler withdrew with its own signal does not. Before, a command the handler did not
await could be left out of the run, and its failure ended Node with an unhandled rejection.
`bounda generate` refuses a port named `reject`.

`app.commands` still throws the rejection, now with `rejected`. The `bounda.commands` counter
counts a failure as `failed`, apart from a rejection. The Cloudflare worker's 409 and the error
`connect` throws carry `rejected`, as does what `failure` from `@bounda-dev/react-router/app`
answers in a React Router project from `create-bounda`, whose order rejects a second placement
with `AlreadyPlaced`.
