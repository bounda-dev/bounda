---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"create-bounda": patch
---

The event that opens an aggregate can export `begin({ event })` instead of `evolve`: it gets the
event alone and returns the fields the aggregate starts with. When one of an aggregate's events
exports `begin`, the inferred state tells a command handler whether the aggregate exists: before
its first event every field is `undefined`, and after it the fields every `begin` sets are always
defined, so a handler that checks `state.status` reads the rest without `?`. The generator writes
that as `OrderState = core.NotCreated<OrderCreatedState> | OrderCreatedState`, and `evolve`, which
only runs on an aggregate that exists, gets `OrderCreatedState`. An aggregate with no `begin`
keeps the state it had, every field optional. The `+types` of every event gain `BeginArgs`.

What `begin` and `evolve` return is merged shallowly over the state, as a process handler's result
already is: an event returns only the fields it sets, and `{ ...state, x }` still works. A field
returned as `undefined` now keeps its value; clear one with `null`. An `evolve` that returns
anything but an object or nothing fails the fold.

An aggregate with a `begin` starts with such an event. A command that would start it with another
event, or put an event that only exports `begin` on an aggregate that exists, throws the new
`CreationOrderError` and stores nothing; a reaction does not retry it. A stream written before
`begin` existed still loads, with a warning. The project from `create-bounda` opens its order with
`begin` and no longer has a `state.ts`.
