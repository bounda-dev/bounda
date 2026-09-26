---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

A process can listen to other aggregates. Its `config` receives every event of the app by
aggregate, `events.payment.PaymentFailed`, so another aggregate's event can start, feed or complete
it, and a handler for one sits in a folder named after that aggregate,
`processes/<process>/payment/on-payment-failed.ts`. Such an event carries its own aggregate's id,
so the process's `index.ts` exports `correlate`, typed as `Process.Correlate`: per aggregate and
event, a function to the id of the process's own aggregate, or `null` to ignore it. The process's
own events still find their instance by `aggregateId`. Boot refuses an event of another aggregate
the process listens to without an entry, and an entry for an event the app does not have.

An event that does not start the process and finds no open instance is skipped, as is any event
for an instance that completed, timed out or failed; a starting event never reopens one. The state
a handler returns is now validated against the process's `state` schema, and a state it refuses
fails the handler for good. A dead-letter replay finds the instance through `correlate` too.

Breaking: process configs name events as `events.<aggregate>.<Event>`; run `bounda generate`. A
hand-written registry groups process handlers by aggregate (`handlers.order.orderPaid`).
