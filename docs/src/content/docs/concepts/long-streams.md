---
title: Long streams close their books
description: What to do in Bounda with a stream that keeps growing, an account or the stock of a SKU, why closing the books comes before snapshots, and why snapshots will only come with a validity the runtime checks itself.
sidebar:
  order: 51
---

Every command in Bounda loads its aggregate's whole stream and folds it: `begin` for the first
event, `evolve` for each one after, every upcaster in the chain on the way. For an order, with its
dozen events, that costs nothing. For a bank account or the stock of a SKU, which gain events every
day and never end, the cost grows with the stream, forever. The usual answer is a snapshot. Bounda's
answer is, first, a different model: **a stream that never ends is usually a business period that
nobody has named yet; close it, and open the next one carrying only what it needs.**

## Close the books

Accountants do not recompute a balance from the day the account was opened. They close a period,
carry the closing balance forward as the opening balance of the next one, and leave the old period
alone. In Bounda that is an aggregate per period, `ledger`, with a predictable id such as
`acc-42:2026-10`, so whoever posts an entry knows from the date which ledger to address:

```ts
// app/domain/ledger/ledger-opened.ts
import type { Event } from "./+types/ledger-opened";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ accountId: z.string(), period: z.string(), balance: z.number() });

export const begin = ({ event }: Event.BeginArgs) => ({
  status: "open" as const,
  accountId: event.payload.accountId,
  balance: event.payload.balance,
});
```

`EntryPosted` folds each movement into `balance`. The closing event is the summary, with what the
next period needs and nothing more:

```ts
// app/domain/ledger/commands/close-ledger.ts
import type { Command } from "./+types/close-ledger";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ ledgerId: z.string(), nextPeriod: z.string() });

export const rejections = ({ command }: Command.RejectionsArgs) => ({
  NotOpen: `Ledger ${command.aggregateId} is not open`,
});

export const handler = ({ command, state, events, reject }: Command.HandlerArgs) => {
  if (state.status !== "open") return reject("NotOpen");
  const { nextPeriod } = command.payload;
  return [events.ledgerClosed({ accountId: state.accountId, nextPeriod, balance: state.balance })];
};
```

A policy opens the next period from it:

```ts
// app/domain/ledger/policies/open-next-on-ledger-closed.ts
import type { Policy } from "./+types/open-next-on-ledger-closed";

export const handler = async ({ event, commands }: Policy.HandlerArgs) => {
  const { accountId, nextPeriod: period, balance } = event.payload;
  await commands.openLedger({ ledgerId: `${accountId}:${period}`, accountId, period, balance });
};
```

`openLedger` returns `[]` when that ledger already exists, so the policy running twice changes
nothing; `postEntry` rejects on a ledger that is not open. The closing itself can be a scheduled
command at the end of the month, a process deadline, or an operator's action: the domain decides
when a period ends, which is the point. Each stream now holds one month of one account, and every
command folds that month alone, while the closed ones stay in the event store for a read model
that shows the account across years. The same shape fits a SKU's stock with a stock-take per
period, or a cashier's shift.

## Why there are no snapshots yet

A snapshot stores the folded state so that the next load starts from it instead of from the first
event. It is a cache, and a cache can be stale. The question is what a stale one breaks.

A stale read model shows wrong rows. That is bad, and it is repairable: `bounda rebuild` projects
the history again into a fresh table, and the history never changed. A stale snapshot is the
**state commands decide from**. A handler that reads it accepts what it should reject, or computes
a balance from a number that is no longer right, and the events it returns are stored as facts.
The next fold, even a correct one, starts from those facts, and no rebuild removes an event. A bad
snapshot does not show old data; it writes wrong history, for as long as it is used.

Snapshots go stale for ordinary reasons: an `evolve` fixed, a field added to `begin`, a new
upcaster, a `state.ts` with another initial value. Any deploy that changes how the state is folded
makes every stored snapshot a fold by code that no longer exists. Axon asks a person to notice:
it filters snapshots by the `@Revision` of the aggregate class, which its
reference says to adjust on every deployment that changes the aggregate's state. Bounda's state is
inferred by the generator and carries no version a person maintains, and a version someone has to
remember to bump is the bug waiting for the one deploy where they forget.

So the stance is: **snapshots only with a validity the runtime checks itself**. They are planned as
a cache of the fold and never the source of truth: one that is missing, unreadable or doubtful is
ignored, and the stream is folded from the start, with the same result. A snapshot will be valid
only for a fingerprint of the modules that shape the state, so that a change to any of them makes
the old ones unusable without anyone deciding so. `bounda rebuild` already works that way: a paused
rebuild resumes only under a digest of the same view and projections, and starts again otherwise.
There is no date and no API for snapshots yet.

## What snapshots would not do

- **Speed up a rebuild.** A rebuild runs projections over the global stream; it never folds an
  aggregate, so an aggregate's snapshot saves it nothing. What would make a large rebuild faster
  is projecting the history in segments, a different piece of work.
- **Raise the ceiling.** A store (the event store of one database, PostgreSQL schema or Durable
  Object, with everything that hangs off it) has one writer at a time, and a snapshot saves a
  read, not a commit. More throughput comes from
  [one store per tenant](/concepts/how-it-runs/#the-way-out-one-store-per-tenant).

## How others do it

- **Marten** treats a snapshot as a projection of a single stream: `Snapshot<T>` registered as
  `Inline` is updated in the transaction that appends the events, and stored as an ordinary
  document. Marten 8 also offers stream compacting, which replaces a stream's old events with one
  event holding the state; its documentation offers it for a stream modelled longer than it
  should have been, and its own example admits that closing the books was the better answer.
- **EventStoreDB**, now KurrentDB, had no built-in snapshotting when Greg Young answered on its
  forum in 2016. He called snapshots a versioning cost many systems do not want, since adding a
  field means deleting and rebuilding them all. Kurrent's blog, in a post by Oskar Dudycz, says
  reading a few dozen events is not a significant overhead and that needing snapshots may hint at
  a flaw in the model, and it puts closing the books first and snapshots last.
- **Axon** creates snapshots from a trigger; the one it ships fires when loading an aggregate
  takes more events than a threshold, and the snapshotter, best run on a thread of its own, stores
  the aggregate instance itself. The `@Revision` filter above is what keeps old snapshots out
  after a change, as long as someone changes the revision.
- **Oskar Dudycz** calls short streams the most important modelling practice in event sourcing
  and closing the books its main enabler; snapshots, he writes, get harder to keep consistent with
  the events as the model grows, while a stream with few events and no lifecycle can live long.

## What stays outside

- **A stream with no period and many events.** If the business has nothing to close, the fold is
  paid on every command until snapshots exist.
- **The moment between periods.** A command writes one stream, so the next ledger opens when the
  policy runs, after the closing commits, not in the same transaction. An entry posted in between
  is rejected and retried by its caller.
- **Finding the open instance without a predictable id.** When periods have no calendar, the
  current one is found through a read model, which is eventually consistent; the rejection on a
  closed ledger keeps a stale answer from writing anything.

## Where to read more

- [What is not there yet](/reference/limitations/), the short version of this
  page, and [Changing an event's shape](/guides/changing-events/) for the upcasters every fold
  runs.
- [State](/guides/project-layout/#state) and [policies](/guides/project-layout/#policies-policies),
  for the modules used above.
- Oskar Dudycz, [Keep your streams short](https://event-driven.io/en/keep-your-streams-short-temporal-modelling-for-fast-reads-and-optimal-data-retention/),
  [Implementing Closing the Books](https://event-driven.io/en/closing_the_books_in_practice/),
  [Should you always keep streams short?](https://event-driven.io/en/should_you_always_keep_streams_short/)
  and [Snapshots in Event Sourcing](https://www.kurrent.io/blog/snapshots-in-event-sourcing/) on
  Kurrent's blog.
- Greg Young on [snapshots and versioning](https://discuss.eventstore.com/t/streams-snapshots-denormalization/1392).
- Axon's [snapshotting](https://docs.axoniq.io/axon-framework-reference/4.11/tuning/event-snapshots/),
  Marten's [single stream projections and snapshots](https://martendb.io/events/projections/single-stream-projections)
  and [stream compacting](https://martendb.io/events/compacting).
