---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

A process can listen to other aggregates. Its `config` receives every event of the app by
aggregate, `events.payment.PaymentFailed`, so another aggregate's event can start, feed or complete
it, and a handler for one sits in a folder named after that aggregate,
`processes/<process>/payment/on-payment-failed.ts`. Such an event carries its own aggregate's id,
so it finds its instance through the id field of its payload or through the process's
`correlate` (see the entry on correlating by convention). The process's own events still find
their instance by `aggregateId`. A correlator that throws, or returns anything but a non-empty
string or `null`, dead-letters that event for the process instead of stopping every process at it.

An event that does not start the process and finds no open instance is skipped, as is any event
for an instance that completed, timed out or failed; a starting event never reopens one. The state
a handler returns is now parsed with the process's `state` schema (defaults filled, undeclared keys
dropped), and a state it refuses fails the handler for good. A dead-letter retry finds the instance through `correlate` too.

Breaking: process configs name events as `events.<aggregate>.<Event>`; run `bounda generate`. A
hand-written registry groups process handlers by aggregate (`handlers.order.orderPaid`).
