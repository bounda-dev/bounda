---
title: Testing
description: An app in memory, a clock that only moves when told to, and assertions that do not flake.
sidebar:
  order: 4
---

`createTestApp` builds an app for tests: in-memory storage, a clock that only moves when you move
it, and sequential ids (`id-1`, `id-2`, …). Nothing is shared between tests and nothing depends on
wall-clock time, so the same assertions hold on every run.

```ts
import { DomainError } from "@bounda-dev/core";
import { createTestApp } from "@bounda-dev/core/testing";
import { describe, expect, it } from "vitest";
import { registry } from "../.bounda/registry.ts";

const orderId = "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01";

describe("orders", () => {
  it("places an order and lists it for the customer", async () => {
    const { app } = await createTestApp({ registry });
    await app.commands.placeOrder({ orderId, customerId: "ada", total: 42 });
    await app.processUntilIdle();

    expect(await app.queries.listOrders({ customerId: "ada" })).toEqual({
      orders: [{ orderId, customerId: "ada", total: 42, placedAt: expect.any(Date) }],
      total: 42,
    });
    await app.stop();
  });
});
```

That is the shape of every test: dispatch a command, `await app.processUntilIdle()`, assert
through a query. This one is the test a new project comes with.

## `processUntilIdle` is the whole trick

A command returns as soon as its events are stored. Projections, policies and processes run
afterwards, so asserting straight after the command would race them. `processUntilIdle()` runs
dispatcher passes and due scheduled commands until nothing moves, which is the point where every
consequence of what you dispatched has happened.

It works in every runtime role, and it is the reason tests need no timers, no polling and no
`await sleep(50)`. It resolves to `{ idle: true }`; pass `{ maxPasses }` to stop earlier, which is
how a test checks that a chain of reactions takes more than one round.

Call `app.stop()` when the test ends: it waits for passes in flight and closes storage.

## Rules that must be refused

A handler that rejects a command throws a `DomainError`. Assert on the type, not on the message,
so the wording stays free to change:

```ts
await expect(
  app.commands.placeOrder({ orderId, customerId: "ada", total: 1 }),
).rejects.toBeInstanceOf(DomainError);
```

## Time

The clock starts at `2026-01-01T00:00:00Z` and stays there until you advance it. A scheduled
command becomes due, and a process time-out fires, because the clock moved — never because the
test waited.

```ts
const HOUR = 3_600_000;

it("reminds the customer a day later only while the order is still placed", async () => {
  const { app, clock } = await createTestApp({ registry });
  await app.commands.placeOrder({ orderId: ORDER, customerId: "ada", items });
  await app.processUntilIdle();

  clock.advance(24 * HOUR);
  await app.processUntilIdle();
  expect((await app.queries.getOrderSummary({ orderId: ORDER }))?.reminderSent).toBe(true);
  await app.stop();
});
```

The same two lines — advance, then process — test a process that gives up:

```ts
clock.advance(72 * HOUR);
await app.processUntilIdle();
expect(await app.queries.getOrderSummary({ orderId: ORDER })).toMatchObject({
  status: "cancelled",
  cancelledAt: expect.any(Date),
});
```

Pass `now` to start somewhere else: `createTestApp({ registry, now: new Date("2026-06-01") })`.

The clock also owns every wait the runtime makes. A handler time-out fires when the clock passes
it, not after real milliseconds, so a handler that never finishes holds `processUntilIdle()` until
you advance the clock past `runtime.policies.timeout`. The background loops that `app.start()`
arms wait on it too: in a test they run only when you advance the clock, and `clock.pending()`
says how many waits are armed, which is none once `app.stop()` has resolved.

## Against a real database

The in-memory adapter is the default, not a requirement. Point the test at SQLite to exercise the
SQL the adapter generates, the column types it picks and the read-model schema it creates:

```ts
import { sqlite } from "@bounda-dev/adapter-sqlite";

const { app } = await createTestApp({ registry, adapter: sqlite({ memory: true }) });
```

An in-memory SQLite database is created per app and thrown away with it, so tests stay isolated
and fast. Use the same for PostgreSQL when a query relies on something only PostgreSQL does.

## Choosing implementations

A command whose module offers more than one implementation of a dependency picks one through
config, and a test picks the one that records instead of sending:

```ts
const { app } = await createTestApp({
  registry,
  adapter: sqlite({ memory: true }),
  config: { commands: { sendConfirmation: { notifier: { use: "memory" } } } },
});
```

Then assert on what it recorded, importing the array the memory implementation exports:

```ts
import { sent } from "../app/domain/order/commands/send-confirmation/notifier.memory.ts";

expect(sent).toEqual([{ orderId: ORDER, customerId: "ada", total: 139 }]);
```

Reset it in `beforeEach`; the module lives as long as the test file does.

Policies and processes choose theirs the same way, by aggregate and then by key:
`config: { policies: { order: { notifyOnOrderPlaced: { mailer: { use: "memory" } } } } }`. They
run after the command, so call `app.processUntilIdle()` before asserting on what they recorded.

## Nothing left behind

`app.getLag()` reports how far each subscriber is behind the stream. Asserting it is zero proves a
test left no work pending, which catches a policy that quietly stopped reacting:

```ts
expect((await app.getLag()).maxLag).toBe(0);
```

## What is worth testing

- **The rules**, through commands: what is accepted, what throws `DomainError`, and what the
  aggregate does on the second attempt.
- **The consequences**, through queries: the read model after the events, including fields a
  projection fills from more than one event.
- **Time**, by advancing the clock: reminders that go out, reminders that no longer apply, and
  processes that run out of time.
- **Not the internals.** Events, projections and process state are how the app gets there;
  asserting on them turns a refactor into a test rewrite. Commands in, queries out.
