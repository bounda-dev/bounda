---
title: Changing an event's shape
description: Events are forever; their payloads are not. An upcast module next to the event brings old ones up to date as they are read.
sidebar:
  order: 7
---

A stored event never changes. Its payload was written by the code of its day, and a year later
that shape may no longer be what `apply`, your projections and your policies expect. Bounda's
answer is an **upcast**: a pure function that takes the payload as one version stored it and
returns the payload of the next version. It lives next to the event, in `<event>.upcast.ts`, and
the runtime applies it every time an old event is read.

```
app/domain/order/
  order-placed.ts           the event, as it is today
  order-placed.upcast.ts    how older payloads become today's
```

```ts
// app/domain/order/order-placed.upcast.ts
import type { Event } from "./+types/order-placed";

interface PayloadV1 {
  readonly customerId: string;
  readonly lines: readonly { readonly sku: string; readonly quantity: number; readonly price: number }[];
}

export const upcasts = [
  // v1 → v2: `price` became `unitPrice`
  (payload: PayloadV1) => ({
    customerId: payload.customerId,
    lines: payload.lines.map(({ sku, quantity, price }) => ({ sku, quantity, unitPrice: price })),
  }),
] satisfies Event.Upcasts;
```

`upcasts` is an array, oldest version first. Each function turns the payload of version `n` into
the payload of version `n + 1`; the last one produces the payload the event has today, and
`Event.Upcasts` checks that it does. Run `bounda generate` after adding the file, as for any
module.

## What the runtime does

- Every stored event carries `metadata.schemaVersion`. An event with `n` upcasts is written with
  version `n + 1`; an event that never changed shape stays at `1`.
- When an event is read, for a command, a policy, a process, a projection or a rebuild, the
  upcasts from its stored version on are applied to the payload. What reaches `apply` and the
  handlers is always the current shape, stamped with the current version. Nothing is rewritten
  in the store.
- An event written with a version this code does not know, because a newer deploy wrote it,
  is refused with an error naming the event. Roll forward, never back, once new events exist.

The types keep you honest in one direction: the last step must return the current payload, so a
change to `payload` in the event module fails to compile until the upcast catches up. TypeScript
cannot follow the chain between steps; each function's parameter is what the previous one returns,
and that is on you.

## When to write one, and when not to

- **A field renamed, split, merged or re-typed**: an upcast.
- **A new optional field**: nothing. Old payloads simply lack it; `apply` reads `undefined`.
- **A new required field**: an upcast that fills it with the value the old world implied.
- **Something that was never in the payload and cannot be derived**: not an upcast. Introduce a
  new event type and keep handling the old one; upcasts transform, they do not invent.

Upcasts are cheap but not free: they run on every read of an old event. An aggregate with
thousands of them re-runs the chain on every command until snapshots exist, and a rebuild runs
it over the whole stream once.

## What is not covered yet

- **Renaming or removing an event type.** Upcasts change the payload, not the type. A stored
  event whose module is gone still fails to fold; keep the module, even if `apply` returns the
  state unchanged.
- **Process state.** A process keeps its state in its own lifecycle events. Changing that
  state's shape has the same problem and no upcast yet; a `state.upcast.ts` in the process
  directory is the natural extension when it is needed.
