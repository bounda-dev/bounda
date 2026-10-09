---
title: Sagas, policies and processes
description: Why Bounda has policies and processes but no saga module, and why compensation is a command the handler sends rather than a hook the runtime calls.
sidebar:
  order: 20
---

"Saga" means three different things depending on whose documentation you read. In the
[paper that named it](https://www.cs.princeton.edu/research/techreps/598), it is a long transaction
written as a sequence of shorter ones, each with a compensation that undoes its effect. In
Axon and NServiceBus it is a class with state that listens to messages and decides what to do
next. In the microservices literature it is both at once, split into a choreographed and an
orchestrated flavour. Bounda keeps the word for the first meaning and gives the other two their
own names. This page explains that split and the decision that follows from it: there is no
compensation hook.

## Two modules, one pattern

Bounda has two kinds of module that react to events, and neither is called a saga.

- A **policy** answers one event with commands and remembers nothing. Its module is a `handler`,
  with an optional `on` and `delay`; there is no state to declare.
- A **process** is a process manager. It always lives on a main aggregate, has one instance per
  instance of that aggregate, and keeps state between events in a stream of its own. It listens
  to other aggregates' events too, and `correlate` says which instance each one belongs to. It
  can have deadlines and a `timeout`.

A **saga** is a pattern built with them: a business transaction of several steps where each step
that can be undone has a compensation. **Choreography** builds it from policies that answer each
other's events, with no coordinator. **Orchestration** builds it from a process that holds the
steps in one place. Chris Richardson's [saga pattern](https://microservices.io/patterns/data/saga.html)
draws the same line. And the converse holds: not every policy or process is a saga. A policy that
sends a confirmation email has nothing to compensate.

Naming the pattern after what it is used for, not after a class, keeps the choice between
choreography and orchestration open. Each module's guide says when to use it:
[which one](/guides/reacting-to-events/#which-one). For a saga, the rule of thumb is memory. A few
independent steps fit policies, where each file is simple and no file says how the whole flow goes
([the choreographed version](/guides/sagas/#the-choreographed-version)). A flow that has to remember
something, such as which payment belongs to the order or a deadline that moves, fits a process.

## Why compensation has no hook

A saga framework could give each step an `on-failed.ts`, called by the runtime when the step
fails. Bounda does not, because the two ways a step can be told no already reach a handler, and a
hook would be a third channel for the same thing.

**A command that says no answers its caller.** Inside a policy or a process, `await commands.x()`
resolves with the command's answer, and a rejection is a value of it, not an exception. The handler
that sent the step holds the answer in the same run and compensates on the spot. In the storefront
checkout, a payment that settles for an order that is no longer open is given back:

```ts
// order/processes/order-lifecycle/payment/on-payment-settled.ts
export const handler = async ({ event, aggregateId, commands }: Process.HandlerArgs) => {
  const paid = await commands.markOrderPaid({ orderId: aggregateId });
  if (paid.rejected === "NotOpen") {
    await commands.cancelPayment({ paymentId: event.aggregateId, reason: "order no longer open" });
  }
  return { paymentDeadline: null };
};
```

Both commands commit together with the rest of the step, or neither does
([what `await commands.x()` means](/concepts/event-store-as-outbox/#what-await-commandsx-means-inside-a-handler)).
`rejected` is typed by the codes `markOrderPaid` declares, so the compensation is checked by the
compiler.

**A failure that happens later, elsewhere, is an event.** A declined card is not the answer to a
command the process sent: the provider reports it through a webhook, `declinePayment` appends
`PaymentDeclined`, and the process reacts to it with `on-payment-declined.ts`, as to any other
event. When to make a "no" a rejection and when an event is the subject of
[Not every no is a fact](/concepts/rejection-or-event/).

What is left is a step that throws: a provider that cannot be reached, a bug. That is not an
answer of the domain, and compensating it would be wrong. The runtime
[retries it](/guides/reacting-to-events/#retries-and-timeouts) under the same `idempotencyKey`,
and dead-letters it when it cannot succeed. This is the order Azure's
[Compensating Transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction)
recommends too: retry what may be transient, compensate only when going forward is impossible.

So **compensation is just another command**. It is not registered ahead of time, run in reverse
order, or called by the runtime. It is a command the handler sends because of what it was told,
and like any command it decides from the state of its own aggregate
([a compensation is a command that decides from state](/guides/sagas/#a-compensation-is-a-command-that-decides-from-state)).

## Event sourcing is the version file

A saga has no isolation: another saga, a customer or the outside world can act between two of
its steps. Richardson's [QCon San Francisco 2017 slides](https://archive.qconsf.com/system/files/presentation-slides/dataconsistencyinmicroserviceusingsagasqconsf2017-1711151847291.pdf)
list countermeasures for it. One is the *version file*: record the operations that arrived, a
cancellation included, so that create then cancel ends where cancel then create does. He adds that
it "sounds suspiciously like event sourcing".

In Bounda it is not a countermeasure to add. An aggregate's stream already records the
compensation, so the late step finds it in the state. A customer cancels, then pays with the link
they still had open: `settlePayment` on a cancelled payment settles it and asks for the refund in
the same decision. `cancelPayment` and `settlePayment` commute, and the money goes back once in
either order ([commutative compensations](/guides/sagas/#commutative-compensations)). The
compensation is a fact of the stream, not an entry in a separate file that has to be kept in step
with it.

## How other frameworks draw the lines

- **Axon** calls a [saga](https://docs.axoniq.io/axon-framework-reference/4.11/sagas/implementation/)
  an event listener that manages one business transaction: an instance with state, started and
  ended by events, found through an association property, which may take compensating actions. In
  Bounda's terms that is a process.
- **NServiceBus** describes a [saga](https://docs.particular.net/nservicebus/sagas/) as a
  message-driven state machine with persisted state, whose instance a message finds through a
  mapped property, and which can request timeouts. Again, a process.
- **Temporal** has no saga construct: the [saga pattern](https://docs.temporal.io/design-patterns/saga-pattern)
  is workflow code that registers a compensation before each step and runs them in reverse order
  when one fails. It shares Bounda's view that compensation is ordinary code. It differs in the
  model: a stack of undo actions kept by the workflow, where Bounda has each compensation decide
  from its aggregate's state, so the order matters only when one compensation depends on another.

## What stays outside

- **Isolation.** Nothing locks an aggregate for the length of a saga. A semantic lock is state you
  model, such as an order in `paying` that `cancelOrder` refuses, and it narrows a race rather than
  closing it ([the semantic lock is state](/guides/sagas/#the-semantic-lock-is-state)).
- **A compensation that fails for good.** It is not compensated in turn. It becomes a
  [dead letter](/guides/dead-letters/), for an operator to fix and retry; what
  happens to the instance meanwhile is [When a process fails](/concepts/when-a-process-fails/).
- **Effects outside the store.** A compensation decides inside the store; giving money back happens
  in a policy that reacts to the event it stored, with its `idempotencyKey`, at least once.
- **Steps in another store.** A store, one database, one PostgreSQL schema or one Durable Object,
  is the unit a handler can `await` a command in. A step that runs in another store or another
  system cannot answer with a rejection; its answer comes back as an event.

## Where to read more

- [Sagas and compensation](/guides/sagas/), the storefront checkout built step by step, and
  [the storefront example](/examples/storefront/) it comes from.
- [What a command answers](/guides/reacting-to-events/#what-a-command-answers), the result a
  policy or process gets from `await commands.x()`.
- [Not every no is a fact](/concepts/rejection-or-event/), for when a "no" is an event.
- Hector Garcia-Molina and Kenneth Salem, [Sagas](https://www.cs.princeton.edu/research/techreps/598), 1987.
- Chris Richardson, [Pattern: Saga](https://microservices.io/patterns/data/saga.html), his talk
  [Using sagas to maintain data consistency in a microservice architecture](https://www.youtube.com/watch?v=YPbGW3Fnmbc)
  and his [QCon San Francisco 2017 slides](https://archive.qconsf.com/system/files/presentation-slides/dataconsistencyinmicroserviceusingsagasqconsf2017-1711151847291.pdf).
- Azure Architecture Center, [Compensating Transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction).
- Axon's [saga implementation](https://docs.axoniq.io/axon-framework-reference/4.11/sagas/implementation/),
  NServiceBus's [sagas](https://docs.particular.net/nservicebus/sagas/) and Temporal's
  [saga pattern](https://docs.temporal.io/design-patterns/saga-pattern).
