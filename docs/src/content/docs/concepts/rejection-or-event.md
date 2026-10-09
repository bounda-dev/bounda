---
title: Not every no is a fact
description: How a command in Bounda says no, why some refusals are events and most are rejections that are neither stored nor published, and where the line falls.
sidebar:
  order: 21
---

A command is a request, and a request can be refused. Greg Young's
[CQRS Documents](https://cqrs.wordpress.com/wp-content/uploads/2010/11/cqrs_documents.pdf) make the
point through grammar: a command is phrased in the imperative because the domain is allowed to
reject it, while an event is in the past tense, something that already happened and that the
domain cannot take back. So the refusal belongs to the command. The open question is what the
refusal becomes: something the aggregate stores, or only an answer.

Bounda's criterion is one sentence: **an event is what the domain remembers; a rejection is the
answer to whoever asked.**

## Where the line falls

A "no" is an event when any of these holds:

- **The business remembers it.** Someone will ask how often it happened, or the aggregate's next
  decision depends on it.
- **Someone else listens to it.** A policy, a process or a read model reacts to it.
- **Whoever asked cannot await the answer.** The asker lives in another store, the unit a command
  runs in (one database, one PostgreSQL schema or one Durable Object), or outside the app. An
  answer it cannot hold has to come back as something it can read later.

Otherwise it is a **rejection**, which is neither stored nor published. The storefront checkout
has both kinds:

- `markOrderPaid` on an order that is no longer open answers `NotOpen`. Only the process that sent
  it cares, it is waiting for the answer, and it gives the money back on the spot. A rejection.
- A declined card is a "no" from the provider, which answers through a webhook, later and from
  outside: `declinePayment` appends `PaymentDeclined`, and the order's process reacts to it. An
  event, because nobody could await it.
- The order then records `OrderPaymentFailed`, which takes it back from `paying` to `placed`: the
  aggregate remembers the failure, because its next decision depends on it. An event.

## Not "does it change the state"

The tempting test is whether the "no" changes anything: if it does not, it is not an event. The
test fails on the events that change nothing in the aggregate's state and are still facts, ones
that others react to or that the business counts. Jérémie Chassaing's
[Decider](https://thinkbeforecoding.com/post/2021/12/17/functional-event-sourcing-decider), where
`decide` only ever returns events, recommends exactly that: a refused transfer as an event that
leaves the state alone, so that an empty result is never mistaken for a crash.

Bounda keeps his other rule, that repeating what is already done returns no events (`[]`, not a
rejection), and answers the diagnosis argument in another way. A rejection is not silent: it is
recorded on the command's span and counted in the commands metric with the outcome `rejected`,
and one that a reaction met is logged at `info` and returned by `runUntilIdle()` in tests. What it
does not do is enter the event store, where it would stay forever, be replayed into every new read
model, and be delivered to every subscriber for an answer only one caller wanted.

## Named for the reason

An event is named for what happened: `OrderPaid`, `PaymentDeclined`. A rejection is named for why
the command was refused: `NotOpen`, `PaymentInProgress`, never `OrderClosed`. The difference keeps
the two from being confused when reading a handler, and it follows Young's grammar: the fact is
past, the refusal is the domain's reason, here and now.

## Declared in the command

A command that may say no declares its codes in `rejections`, with a message each, and its handler
gets `reject`, which only takes those codes:

```ts
// order/commands/mark-order-paid.ts
export const rejections = ({ state }: Command.RejectionsArgs) => ({
  NotOpen: `Only open orders can be paid; this one is ${state.status ?? "new"}`,
});

export const handler = ({ state, events, reject }: Command.HandlerArgs) => {
  if (state.status === "paid" || state.status === "fulfilled") return [];
  if (state.status !== "placed" && state.status !== "paying") return reject("NotOpen");
  return [events.orderPaid()];
};
```

`reject(code)` is the only way to reject. A `DomainError` the handler did not make with its own
`reject`, such as one rethrown from another app's command, is traced and counted as a failure,
and in a reaction it fails the run instead of answering it. Where the answer goes depends on who
asked. `app.commands` throws the rejection to its caller, with the code in `rejected`. A policy or
a process gets it as a value: `commands.markOrderPaid()` resolves with `rejected` set to
`"NotOpen"`, typed by the declared codes, so a typo does not compile
([what a command answers](/guides/reacting-to-events/#what-a-command-answers)).

A rejection a reaction does not look at changes nothing: the attempt goes on, and the rejection is
logged and traced. Errors stay `throw`. A payload that does not validate or a bug fails the attempt,
which the runtime retries or dead-letters; it never turns into an answer the handler might ignore.

## Why not the other ways

- **Every "no" an event.** It is the Decider's choice, and Oskar Dudycz often makes it too in
  [Throw, Result or neither](https://event-driven.io/en/throw-result-or-neither/), for failures
  worth keeping as business data. For those, Bounda agrees. For the rest it stores answers nobody
  remembers. Worse, an event that exists so one particular consumer reacts to it is what Dudycz
  calls a [passive-aggressive event](https://event-driven.io/en/passive_aggressive_events/): a
  command in disguise. A rejection says it straight, to the one who asked.
- **Every "no" a plain exception.** An exception says nothing in the types: the compiler cannot
  list a command's answers or check the code a caller compares, and in a reaction a throw fails
  the run, so a refusal would end as a dead letter like a bug. Dudycz makes the same point about
  asynchronous handlers: with no caller to catch the error, a refusal should be data.
- **A `Result` type everywhere.** A reaction's `await` already returns the rejection as a value,
  which is what a `Result` would give; at `app.commands`, a throw is what an HTTP action or a test
  expects, and [`failure`](/guides/react-router/#errors-from-the-domain) turns it into a React
  Router action's response.

## What stays outside

- **History of rejections.** Nothing in the store says how often `NotOpen` happened. If the
  business starts to ask, the "no" has become something the business remembers: add an event.
  Rejections from before then are only in the logs and traces.
- **Refusals across stores.** Inside a store, a reaction awaits a command and holds its answer.
  Across stores or services, as in the
  [saga pattern](https://microservices.io/patterns/data/saga.html), the outcome has to travel back
  as a message, an event or a reply, because nobody is waiting on the other side.
- **Scheduled commands.** One rejected when it runs has nobody waiting either: it changes nothing,
  and the rejection is logged.

## Where to read more

- [Rejections](/guides/project-layout/#rejections), the file contract, and
  [testing rejections](/guides/testing/#rejections-inside-reactions).
- [Two ways to fail, no hook for either](/guides/sagas/#two-ways-to-fail-no-hook-for-either) in the
  saga guide, and [Sagas, policies and processes](/concepts/sagas-policies-and-processes/) for why
  compensation needs nothing more.
- Greg Young, [CQRS Documents](https://cqrs.wordpress.com/wp-content/uploads/2010/11/cqrs_documents.pdf).
- Jérémie Chassaing, [Functional Event Sourcing Decider](https://thinkbeforecoding.com/post/2021/12/17/functional-event-sourcing-decider).
- Oskar Dudycz, [Throw, Result or neither](https://event-driven.io/en/throw-result-or-neither/) and
  [Passive-aggressive events](https://event-driven.io/en/passive_aggressive_events/).
- Chris Richardson, [Pattern: Saga](https://microservices.io/patterns/data/saga.html).
