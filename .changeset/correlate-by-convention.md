---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

An event of another aggregate that a process listens to reaches the instance its payload's id
field names, the field named after the process's aggregate (`orderId` for an `order` process, or
the `aggregateId` of its `state.ts`), with nothing to declare; a `null` there belongs to no
instance. Boot reads the field from the event's schema, and still refuses an event that has
neither the field nor a `correlate` entry.

`correlate` is now a function, like `config` and `state`: it gets `from` and returns
`from.<aggregate>.<Event>((event) => …)` for each event it decides, with `event` typed without
annotating anything. It overrides the id field. The `+types` of a process `index.ts` give
`CorrelateArgs` instead of `Correlate`; `ProcessCorrelate` is replaced by `ProcessCorrelateArgs`
and `ProcessCorrelation`. Boot refuses a `correlate` that is not a function, that does not return
such a list, that names an event twice or that throws.
