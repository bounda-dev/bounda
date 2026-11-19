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
such as creating that payment intent, so a second run does not create another. It is not the
`idempotencyKey` option of a dispatch, which keeps a command a client sends twice from running
twice ([idempotent commands](/guides/idempotent-commands/)). It also receives
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

## Personal data sent out

A port that hands a person's data to a provider, a mailing list, a CRM, an index, makes the provider
a recipient of it, and the GDPR asks that it be told when the data is erased, restricted or
corrected. The port declares it in its own module, with the handlers that tell it, and the runtime
records whose data each call hands it and tells it when it has to know: see
[Recipients](/guides/personal-data/#recipients).

## Personal data a port returns

What a call answers, Bounda cannot read: a CRM's contact, a directory's entry, a provider's
profile. A handler that quotes it in an error, or in a rejection its command remembers, writes
someone's personal data into text Bounda keeps, and only the port knows whose. So a port whose
calls answer what can hold text says, in its own module, whose personal data each call returns:

```ts
// app/domain/customer/crm.ts
import type { Port } from "./+types/crm";

export interface Contact {
  readonly customerId: string;
  readonly email: string;
}

export interface Crm {
  contact(customerId: string): Promise<Contact | null>;
  household(customerId: string): Promise<readonly Contact[]>;
  ping(): Promise<boolean>;
}

export const returnsPersonalData = {
  contact: { persons: ({ result }) => result?.customerId, categories: ["contact"] },
  household: {
    persons: ({ args: [customerId], result }) => [customerId, ...result.map((c) => c.customerId)],
    personsOnError: ({ args: [customerId] }) => customerId,
    categories: ["contact"],
  },
} satisfies Port.ReturnsPersonalData;
```

Each method maps to `false`, when it returns nobody's data, or to what it returns: `persons`, a
function of the call's `args` and its `result`, the promise awaited, that names the person ids,
one, several or none, `null` and `undefined` naming nobody; `personsOnError`, the same of a call
that failed, naming whom its `error` may quote, nobody when left out; and the
[categories](/guides/personal-data/#categories) of the data, `default` when left out. A port that
is a function takes one such declaration, or `false`, for its calls, and a port whose calls return
nobody's data at all says `export const returnsPersonalData = false`.

The run that called it then counts as having read that data, as if it had opened fields of those
persons of those categories, each under the key they hold for the category, created when they hold
none, as a field of theirs would be:

- the text of a dead letter, of a subscriber's failure or of a remembered rejection is encrypted
  under their keys too, so it is listed in their export, withheld from anyone else's (article
  15(4)), unreadable once they are forgotten, and covered by their restriction: see
  [someone else's data](/guides/personal-data/#someone-elses-data);
- a person whose processing is [restricted](/guides/personal-data/#restricting-processing) in one
  of the categories, or as a whole, makes the call throw `ProcessingRestrictedError` before the
  handler sees the answer, unless the command names a basis with `processRestricted`, the policy or
  process declares one, or the query asks with `includeRestricted`, and the access log records whom
  that basis let through; a recipient's handler, which tells of a restriction, is never refused;
- a call that tells a [recipient](/guides/personal-data/#what-was-disclosed) afterwards records
  the data as disclosed to it, and a command's events are appended only while the persons still
  hold the keys the data was read under;
- a query's access record names them.

The generator types `Port.ReturnsPersonalData` with the port's interface, so `args` and `result`
are typed, a method the port does not have or a category the app does not declare does not
compile, and a method that answers synchronously can only be `false`: what a call returns is read
once its promise settles. `.bounda/types.ts` fails to compile at `<Module>PortReturns` while a
method, or a port that is a function, answers what can hold text and the module does not export
`returnsPersonalData`, naming it, and while a port that is a function has a method that answers
text, since its declaration says what its calls return; split such a port in two. The app refuses
to start, with `ConfigurationError`, on a declaration that is not `false` or an object, without a
`persons` function, or with categories the app does not declare. A `persons` that names something
other than an id, or a method declared as returning data that answers without a promise, makes the
call throw `ConfigurationError`.

## An account per tenant

Some providers differ by tenant: each venue charges through its own Stripe account, each customer
has its own API key. `create` receives the name of the store the app serves as `tenant`, so the
implementation picks the tenant's credentials once, when it is built, and the port and the
handlers stay the same for every tenant. On Cloudflare every tenant is its own Durable Object and
`tenant` is its name; an app with one store, as under `boot()`, has none. Here the accounts are in
a KV namespace of the Worker:

```ts
// app/domain/order/infrastructure/refunds/stripe.ts
import type { CreateImplementation } from "@bounda-dev/core";
import Stripe from "stripe";
import type { Refunds } from "../../refunds.ts";

export const create: CreateImplementation<Refunds> = async ({ env, tenant }) => {
  if (tenant === undefined) throw new Error("refunds need the tenant of the store");
  const stripeAccount = await env.MERCHANT_ACCOUNTS.get(tenant);
  if (stripeAccount === null) throw new Error(`no merchant account for ${tenant}`);
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { stripeAccount });
  return {
    refund: async ({ chargeId, idempotencyKey }) => {
      await stripe.refunds.create({ charge: chargeId }, { idempotencyKey });
    },
  };
};
```

A `create` that throws keeps the app from starting, so a tenant without an account gets no app
rather than one that calls the provider as someone else. A test passes the name to
`createTestApp` as `tenant` ([testing](/guides/testing/#doubles)).

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

