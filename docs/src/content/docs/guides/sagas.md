---
title: Sagas and compensation
description: A business transaction of several steps, each with a way back, built from a process and plain commands.
sidebar:
  order: 6
---

A saga is a business transaction made of several steps, each committed on its own, where a step
that fails undoes the ones before it with a **compensation**: another step that cancels the
effect of the first. Nothing is rolled back; the history keeps both. This page builds one with
the checkout of the [storefront example](/guides/storefront-example/), where the customer pays
through a payment link and the provider reports back through webhooks.

## A saga is a pattern, not a module

There is no saga file in Bounda. A saga is built from what is already there: a
[process](/guides/reacting-to-events/) when one place coordinates the steps (orchestration), or
policies that answer each other's events when nothing does (choreography). The storefront uses a
process, `order-lifecycle`, because its steps depend on what happened before: whether the
customer is still within the payment window, which payment belongs to the order.

Each step is a command, and the steps are not all alike:

| Step | Kind | Compensation |
| --- | --- | --- |
| `placeOrder` | compensable | `cancelOrder` |
| `requestPayment` | compensable | `cancelPayment` |
| `lockOrderForPayment` | semantic lock | `recordPaymentFailure` releases it |
| `markOrderPaid` | pivot | none |
| `fulfillOrder` | retriable | none |

A **compensable** step can be undone by another. The **pivot** is the point of no return: once the
order is paid the saga goes forward. The steps after it are **retriable**: they must succeed
sooner or later, so they are retried rather than compensated. Cancelling an order after it was
paid is still possible, but it is another business operation, a cancellation with a refund, not
the compensation of a failed checkout.

## Two ways to fail, no hook for either

A step fails in one of two ways, and neither needs a special file.

**The command refuses.** The handler that dispatches it gets the `DomainError` from the `await`
and compensates on the spot. When the payment settles, the process marks the order paid; if the
order is no longer open, the refusal is the signal to give the money back:

```ts
// order/processes/order-lifecycle/payment/on-payment-settled.ts
export const handler = async ({ event, aggregateId, commands }: Process.HandlerArgs) => {
  try {
    await commands.markOrderPaid({ orderId: aggregateId });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    await commands.cancelPayment({ paymentId: event.aggregateId, reason: "order no longer open" });
  }
  return { paymentDeadline: null };
};
```

Only a `DomainError` is an answer. Anything else is rethrown, so the runtime retries the step.

**Another aggregate says no.** A failure that happens elsewhere, later, arrives as an event of
that aggregate. The provider declines the card, `declinePayment` appends `PaymentDeclined`, and
the process reacts to it like to any other event:

```ts
// order/processes/order-lifecycle/payment/on-payment-declined.ts
export const handler = async ({ event, aggregateId, commands }: Process.HandlerArgs) => {
  await commands.recordPaymentFailure({ orderId: aggregateId, reason: event.payload.reason });
  await commands.cancelOrder({ orderId: aggregateId, reason: "payment declined" });
  return { paymentDeadline: null };
};
```

Both commands run in one attempt, and the second sees what the first decided: the order is
`placed` again by the time it is cancelled.

There is no `on-failed.ts`. A failure is either the answer to a command, which the caller already
holds, or a fact of another aggregate, which is an event. A hook would be a third channel for
something the two already carry.

## A compensation is a command that decides from state

`cancelPayment` is an ordinary command. It does not assume what the payment did; it looks:

```ts
// payment/commands/cancel-payment.ts
export const handler = ({ command, state, events }: Command.HandlerArgs) => {
  const { reason } = command.payload;
  switch (state.status) {
    case "requested":
    case "processing":
      return [events.paymentCancelled({ orderId: state.orderId, reason })];
    case "settled":
      return state.refund === "none"
        ? [
            events.paymentCancelled({ orderId: state.orderId, reason }),
            events.refundRequested({
              orderId: state.orderId,
              intentId: state.intentId,
              amount: state.amount,
            }),
          ]
        : [];
    default:
      return [];
  }
};
```

The effect of the compensation, giving the money back, is not in the command. `RefundRequested`
is stored first, and a policy carries it out with its `idempotencyKey`, as any
[effect after the commit](/guides/reacting-to-events/#calling-the-outside-world):

```ts
// payment/policies/refund-on-refund-requested.ts
export const handler = async ({ event, commands, gateway, idempotencyKey }: Policy.HandlerArgs) => {
  const { intentId, amount } = event.payload;
  const { refundId } = await gateway.refund({ intentId, amount }, idempotencyKey);
  await commands.recordRefund({ paymentId: event.aggregateId, refundId });
};
```

Compensations go through one place. However the order ends up cancelled (the customer, the
payment deadline, a declined card, the process's own `timeout`), `OrderCancelled` reaches this
handler: it runs before the instance completes, or, when `at-timeout.ts` caused it, after the
instance timed out:

```ts
// order/processes/order-lifecycle/on-order-cancelled.ts
export const handler = async ({ state, event, commands }: Process.HandlerArgs) => {
  if (state.paymentId !== null) {
    await commands.cancelPayment({ paymentId: state.paymentId, reason: event.payload.reason });
  }
};
```

Compensations need not run in the reverse order of their steps. The order was placed before the
payment was requested, yet the order is cancelled first and the payment after it: cancelling the
order is what sets the compensation going. Each compensation decides from the state of its own
aggregate, so their order matters only when one depends on what another did.

## Every step is idempotent

A process step can run more than once, a webhook can arrive twice and a policy is retried after a
failure, so every step tolerates being repeated:

- **A repeated command appends nothing.** Each handler decides from state: `settlePayment` on a
  settled payment, `recordRefund` once the refund is done, `lockOrderForPayment` on an order that
  is no longer `placed` all return `[]`.
- **A refusal that triggers a compensation is kept for what cannot happen.** `markOrderPaid`
  refuses only a cancelled order; on a paid or fulfilled one it returns `[]`. The process refunds
  the payment when it refuses, so a `DomainError` for a repeat would refund an order that was paid.
- **Commands the process dispatches do not throw for a state they cannot rule out.**
  `lockOrderForPayment` and `recordPaymentFailure` return `[]` instead of a `DomainError`: the
  order may have moved on since the event, and a `DomainError` nobody catches fails the process.
- **Ids that leave the app are deterministic.** The process derives the payment's id from its key,
  `idempotencyKeyFor(idempotencyKey, "payment")`, as any reaction does for an id it creates (see
  [Calling the outside world](/guides/reacting-to-events/#calling-the-outside-world)). A retry
  dispatches `requestPayment` with the same id, and that command's `idempotencyKey` is what it
  hands the provider, so the retry asks for the same intent with the same parameters.

## Commutative compensations

The event store keeps a total order; the world outside does not. A webhook can arrive after the
compensation it should have preceded: the customer cancels, then pays with the link they still
have open. The compensation runs first, and the step it compensates arrives late.

The aggregate deals with it, because it remembers the compensation. `settlePayment` on a payment
that was cancelled or declined settles it and asks for the refund in the same decision:

```ts
// payment/commands/settle-payment.ts
case "cancelled":
case "declined":
  return state.refund === "none"
    ? [
        events.paymentSettled({ orderId: state.orderId }),
        events.refundRequested({ orderId: state.orderId, intentId: state.intentId, amount: state.amount }),
      ]
    : [];
```

`cancelPayment` and `settlePayment` therefore commute: in either order the money goes back once.
`declined` is there because a declined intent can still be paid in Stripe, and by then the order
is cancelled. The same applies to the other webhooks: `PaymentProcessing` after `PaymentSettled`
changes nothing, since `markPaymentProcessing` only acts on a requested payment.

Chris Richardson calls this a *version file*, a record of the operations that arrived so that the
ones that arrive out of order can be undone, and observes that it "sounds suspiciously like event
sourcing". An aggregate already is one.

## The semantic lock is state

While the provider processes the payment, the order should not be cancelled: the money may be on
its way. `lockOrderForPayment` puts the order in `paying`, a state that means *a step is in
flight*, and `cancelOrder` decides what to do with it. There are three possible answers to a lock:

- **Refuse.** `cancelOrder` on a `paying` order throws `DomainError("Payment in progress")`. For
  a card the provider answers within seconds, so asking the customer to try again is acceptable;
  a payment method that takes days to clear would call for the next answer instead.
- **Accept and compensate.** `cancelOrder` on a `placed` order is accepted, even though a payment
  link is out: the customer may never pay, and if they do, the payment is refunded. Refusing here
  would make the customer wait for something that may never happen, which Richardson calls a
  questionable user experience.
- **Wait.** Queue the cancellation until the lock is released. It costs state for the queue and
  leaves the customer with no answer, so the storefront does not do it.

The rule of thumb is the length of the wait: refuse for a lock that lasts seconds, accept and
compensate for one that may last days.

The lock reaches the order asynchronously, through the process, after `PaymentProcessing` is
stored. It narrows the race between a cancellation and a payment; it does not close it. When the
two cross, the compensation of the previous section catches it: the payment settles, the order is
no longer open, `markOrderPaid` refuses and the payment is cancelled with a refund.

## A step that never answers

A provider that never calls back would leave the order waiting forever. The process keeps the
payment window as a deadline in its state, `paymentDeadline`, set when the payment is requested
and cleared as soon as the payment moves:

```ts
// order/processes/order-lifecycle/at-payment-deadline.ts
export const handler = async ({ aggregateId, commands }: Process.DeadlineArgs) => {
  await commands.cancelOrder({ orderId: aggregateId, reason: "not paid in time" });
  return { paymentDeadline: null };
};
```

The process's own `timeout`, 30 days in the storefront, is the last resort: it detects an
instance stuck for any reason, a lock nobody released included: it releases the lock and cancels
the order, and the `OrderCancelled` it causes cancels the payment through `on-order-cancelled.ts`,
as any other cancellation does. See [deadlines](/guides/reacting-to-events/#deadlines).

## Retry before compensating

A compensation is expensive: the customer loses the order. A failure that may go away on its own
is retried first, and only an answer is compensated. The runtime does it for every policy and
process step: a provider that cannot be reached throws, and the step is retried with back-off
under the same `idempotencyKey`; a refusal is an answer, `DomainError` or event, and is
compensated.

A compensation that fails for good is not compensated in turn. It becomes a
[dead letter](/guides/reacting-to-events/#dead-letters): an operator looks at it, fixes the
cause and replays it.

The storefront cancels the order at the first declined payment, for simplicity. In Stripe a
declined intent can be retried with another card, so a real checkout would keep the order open
and let the payment window decide.

## The choreographed version

Without the process, the same saga is a set of policies that answer each other's events:
`request-payment-on-order-placed` in the order, `lock-order-on-payment-processing`,
`mark-order-paid-on-payment-settled` and `cancel-order-on-payment-declined` reacting to the
payment, `cancel-payment-on-order-cancelled` in the payment. The payment window becomes a
delayed command, `expireOrder` a few days after `OrderPlaced`, whose handler decides from the
order's state when it runs. Each piece is simpler, and no single file says how the checkout goes.
Choose choreography when the steps are few and independent; choose a process when the saga needs
memory of its own, such as which payment belongs to the order or a deadline that moves.

## Further reading

- Hector Garcia-Molina and Kenneth Salem, [Sagas](https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf), 1987.
- Chris Richardson, [Pattern: Saga](https://microservices.io/patterns/data/saga.html), and his
  [QCon San Francisco 2017 slides](https://archive.qconsf.com/system/files/presentation-slides/dataconsistencyinmicroserviceusingsagasqconsf2017-1711151847291.pdf)
  on compensable, pivot and retriable steps, commutative updates and semantic locks.
- Azure Architecture Center, [Compensating Transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction).
- Stripe: the [payment intent lifecycle](https://docs.stripe.com/payments/paymentintents/lifecycle),
  [webhooks](https://docs.stripe.com/webhooks) and
  [idempotent requests](https://docs.stripe.com/api/idempotent_requests).
