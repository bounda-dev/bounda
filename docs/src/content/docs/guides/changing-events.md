---
title: Changing an event's shape
description: Events are forever; their payloads are not. An upcaster module next to the event brings old ones up to date as they are read, one version at a time.
sidebar:
  order: 7
---

A stored event never changes. Its payload was written by the code of its day, and a year later
that shape may no longer be what `apply`, your projections and your policies expect. Bounda's
answer is an **upcaster**: a pure function that takes the payload as one version stored it and
returns the payload of the next version. Upcasters live next to the event, in
`<event>.upcast.ts`, and the runtime applies them every time an old event is read.

```
app/domain/order/
  order-placed.ts           the event, as it is today
  order-placed.upcast.ts    how older payloads become today's
```

## A chain of versions

Say `OrderPlaced` has changed twice since the first orders were stored. Version 1 had a `price`
per line; version 2 renamed it to `unitPrice`; version 3, today's, added the `currency` that
multi-currency pricing needed. The upcast module holds one upcaster per change, oldest first:

```ts
// app/domain/order/order-placed.upcast.ts
import type { Event } from "./+types/order-placed";

interface PayloadV1 {
  readonly customerId: string;
  readonly lines: readonly { readonly sku: string; readonly quantity: number; readonly price: number }[];
}

interface PayloadV2 {
  readonly customerId: string;
  readonly lines: readonly { readonly sku: string; readonly quantity: number; readonly unitPrice: number }[];
}

export const upcasts = [
  // v1 → v2: `price` became `unitPrice`
  (payload: PayloadV1): PayloadV2 => ({
    customerId: payload.customerId,
    lines: payload.lines.map(({ sku, quantity, price }) => ({ sku, quantity, unitPrice: price })),
  }),
  // v2 → v3: prices gained a currency; everything sold before multi-currency was in euros
  (payload: PayloadV2) => ({ ...payload, currency: "EUR" }),
] satisfies Event.Upcasts;
```

Each upcaster turns the payload of version `n` into the payload of version `n + 1`, and only
knows those two shapes. The last one produces the payload the event has today, and
`Event.Upcasts` checks that it does. Run `bounda generate` after adding the file, as for any
module.

What an old event goes through depends on the version it was stored with:

| Stored with | Upcasters applied when it is read | Reaches `apply` as |
| --- | --- | --- |
| `schemaVersion: 1` | both, in order | version 3 |
| `schemaVersion: 2` | the second one | version 3 |
| `schemaVersion: 3` | none | version 3 |

The next change to the payload is one more upcaster at the end of the array, from version 3 to
version 4. The existing ones stay as they are: they describe history, and history does not change.
Keep the old payload interfaces (`PayloadV1`, `PayloadV2`) in the upcast module for the same
reason, rather than deriving them from today's event.

## What the runtime does

- Every stored event carries `metadata.schemaVersion`. An event with `n` upcasters is written
  with version `n + 1`; an event that never changed shape stays at `1`.
- When an event is read, for a command, a policy, a process, a projection or a rebuild, the
  upcasters from its stored version on are applied to the payload. What reaches `apply` and the
  handlers is always the current shape, stamped with the current version. Nothing is rewritten
  in the store.
- An event written with a version this code does not know, because a newer deploy wrote it,
  is refused with an error naming the event. Roll forward, never back, once new events exist.

The types keep you honest in one direction: the last upcaster must return the current payload, so
a change to `payload` in the event module fails to compile until the upcast module catches up.
They do not check the links in between: `Event.Upcasts` does not verify that each upcaster accepts
what the previous one returns. Annotating every step's parameter and return type, as above, is
what keeps the chain straight.

## When to write one, and when not to

- **A field renamed, split, merged or re-typed**: an upcaster.
- **A new optional field**: nothing. Old payloads simply lack it; `apply` reads `undefined`.
- **A new required field**: an upcaster that fills it with the value the old world implied, like
  `currency: "EUR"` above.
- **Something that was never in the payload and cannot be derived**: not an upcaster. Introduce a
  new event type and keep handling the old one; upcasters transform, they do not invent.

Upcasters are cheap but not free: they run on every read of an old event. An aggregate with
thousands of old events re-runs the chain on every command, since Bounda has no snapshots yet
([what is not there yet](/guides/deployment/#what-is-not-there-yet)), and a rebuild runs it over
the whole stream once.

## What is not covered yet

- **Renaming or removing an event type.** Upcasters change the payload, not the type. A stored
  event whose module is gone still fails to fold; keep the module, even if `apply` returns the
  state unchanged.
- **Process state.** A process keeps its state in its own lifecycle events. Changing that
  state's shape has the same problem and no upcaster yet; a `state.upcast.ts` in the process
  directory is the natural extension when it is needed.
