---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"create-bounda": patch
---

The event that opens an aggregate can export `create({ event })` instead of `apply`: it gets the
event alone and returns the fields the aggregate starts with. When one of an aggregate's events
exports `create`, the inferred state tells a command handler whether the aggregate exists: before
its first event every field is `undefined`, and after it the fields every `create` sets are always
defined, so a handler that checks `state.status` reads the rest without `?`. The generator writes
that as `OrderState = core.NotCreated<OrderCreatedState> | OrderCreatedState`, and `apply`, which
only runs on an aggregate that exists, gets `OrderCreatedState`. An aggregate with no `create`
keeps the state it had, every field optional. The `+types` of every event gain `CreateArgs`.

What `create` and `apply` return is merged shallowly over the state, as a process handler's result
already is: an event returns only the fields it sets, and `{ ...state, x }` still works. A field
returned as `undefined` now keeps its value; clear one with `null`. An `apply` that returns
anything but an object or nothing fails the fold.

An aggregate with a `create` starts with such an event. A command that would start it with another
event, or put an event that only exports `create` on an aggregate that exists, throws the new
`CreationOrderError` and stores nothing; a reaction does not retry it. A stream written before
`create` existed still loads, with a warning. The project from `create-bounda` opens its order with
`create` and no longer has a `state.ts`.
