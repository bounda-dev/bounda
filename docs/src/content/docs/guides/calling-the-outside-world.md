---
title: Calling the outside world
description: Where a call to a provider goes, a command or a reaction, and how to make it safe to repeat with the idempotency key.
sidebar:
  order: 3
---

A command decides and a reaction acts. This page is about the calls in between: what a command
handler may ask the outside world, where an effect goes instead, and the rules that keep an effect
from happening twice when its handler runs again.

## Deciding, then acting

A command handler decides; it does not act on the world. It can run more than once for one
command: when its append loses a concurrency race, the runtime reloads the aggregate and runs the
handler again, ports included, up to `runtime.commands.concurrencyRetries` times, and what it
decided is not stored until the append succeeds. So a command handler only makes calls that are
safe to repeat and harmless if the decision never lands: reading a price, checking stock, creating
a payment intent so the page can show the payment form. What it learned from outside goes into the
event, so the history says what the decision was based on.

The handler receives `idempotencyKey`, the command's id, which stays the same across those runs (a
scheduled command keeps the id it was scheduled with): pass it to a call the provider deduplicates,
such as creating that payment intent, so a second run does not create another. It also receives
`signal`, which aborts when the run passes `runtime.commands.timeout`; pass it to what it calls
outside (`fetch(url, { signal })`), so a provider that hangs fails the command instead of holding
the request (see [Retries and timeouts](/guides/reacting-to-events/#retries-and-timeouts)).

The effect itself (charging the card, sending the email, telling the warehouse) goes in a policy
or process that reacts to the stored event, through one of the aggregate's ports. It runs
after the commit and at least once, and it reports back with a command:

```ts
// policies/charge-on-order-placed.ts
export const handler = async ({ event, commands, payments, idempotencyKey }: Policy.HandlerArgs) => {
  const charge = await payments.charge({ amount: event.payload.total, idempotencyKey });
  if (charge.ok) {
    await commands.recordPayment({ orderId: event.aggregateId, chargeId: charge.id });
  } else {
    await commands.recordPaymentFailure({ orderId: event.aggregateId, reason: charge.reason });
  }
};
```

A refusal from the provider is an answer, not an error: it becomes an event (`PaymentFailed`) that
other reactions can respond to. Throw only when there is no answer, and the runtime retries with
back-off. The event store is the outbox, so nothing else is needed for the effect to follow the
decision. When a later step fails and an effect that already happened has to be undone, the
reaction compensates it: see [Sagas and compensation](/guides/sagas/).

## Making an effect safe to repeat

A few rules keep it correct:

- **Await the commands the handler dispatches.** The run waits for every one before it commits,
  awaited or not, within the handler's time, and one that fails fails the run, even if the handler
  catches its error; one the handler withdraws with its own `signal` does not. Awaiting is what
  keeps them in order, so a second command sees what the first decided, and what gives the
  handler their answers. A command dispatched once the run has finished, from a timer or a promise
  the handler left behind, is not part of it: it is refused (the error's `code` is
  `REACTION_FINISHED`) and logged at `error`, and decides nothing.
- **Pass `idempotencyKey` to every provider that takes one.** It is one key per handler run, and
  the handler passes it as it is, even when the run causes two effects:
  - Two effects on **different providers** (charging the card, sending the receipt) go in a
    reaction each. Each gets its own key, and a failing email does not charge the card again.
  - Two calls to **one provider** (a refund and a new charge) go behind one port method,
    whose implementation derives a key per call with `idempotencyKeyFor` from
    `@bounda-dev/core`. Each key is the same on every retry and a UUID like the handler's, so it
    fits the provider's length limit:

    ```ts
    // app/domain/order/infrastructure/payments/stripe.ts
    import { type CreateImplementation, idempotencyKeyFor } from "@bounda-dev/core";
    import Stripe from "stripe";
    import type { Payments } from "../../payments.ts";

    export const create: CreateImplementation<Payments> = ({ env }) => {
      const stripe = new Stripe(env.STRIPE_SECRET_KEY);
      return {
        replaceCharge: async ({ chargeId, amount, idempotencyKey }) => {
          await stripe.refunds.create(
            { charge: chargeId },
            { idempotencyKey: idempotencyKeyFor(idempotencyKey, "refund") },
          );
          await stripe.charges.create(
            { amount, currency: "eur" },
            { idempotencyKey: idempotencyKeyFor(idempotencyKey, "charge") },
          );
        },
      };
    };
    ```
- **An id the run creates comes from its key.** The key a provider receives stays as it is, but
  the id of an aggregate the run starts (a payment, a shipment) is derived from it in the handler,
  `idempotencyKeyFor(idempotencyKey, "payment")`, one name per id, never `randomUUID()`. A retry
  then dispatches the same command with the same payload, so the provider gets the command's own
  key with the same parameters again. A random id would send it that key with other parameters,
  which a provider such as Stripe refuses.
- **Without a key on the provider's side**, look the operation up by your own reference before
  calling again, and give a process a timeout for a provider that may never answer.
- **The command a reaction dispatches can arrive twice**, when the reaction is retried after
  dispatching it. The retry gives it the same id, so a scheduled command stays scheduled once and
  the command's own `idempotencyKey` does not change, but one that already ran runs again: its
  handler decides from state and returns no events the second time, as `recordConfirmationSent`
  does in the [storefront example](/examples/storefront/).
- **A run that fails leaves no command behind**, so a retry that decides differently starts from
  nothing ([what the runtime promises](/guides/reacting-to-events/#what-the-runtime-promises)).

## Keeping an external index

A search index in Typesense, Elasticsearch or Algolia is a read model in another store, but it is
not a projection: a projection commits with its checkpoint in one transaction of the read model's
database, which a call to another service cannot join ([why](/guides/read-models/#ports)).
Feed it from a policy instead, through a port of the aggregate whose events it indexes. The policy
runs at least once and may run late, so each write is an upsert by id that carries the event's
`version`, the aggregate's own count of its events, and the index keeps a document only when that
version is newer than the one it has:

```ts
// app/domain/order/policies/index-order.ts
import type { Policy } from "./+types/index-order";

export const on = ["OrderPlaced", "OrderPaid", "OrderCancelled"];

export const handler = async ({ event, searchIndex }: Policy.HandlerArgs) => {
  await searchIndex.upsert({
    id: event.aggregateId,
    version: event.version,
    fields: { status: event.type, at: event.timestamp },
  });
};
```

Elasticsearch does the comparison itself with `version_type=external`; with a store that cannot,
the implementation reads the stored version first. An index over two aggregates is a policy and a
port in each, whose implementations share the client from outside `app/domain`.

