---
title: Reading the global stream
description: Read a store's events by position, as they were stored, for an operator's console, an audit trail or a page that follows the stream.
sidebar:
  order: 11
---

Every event a store commits takes the next position in its
[global stream](/concepts/how-it-runs/): the events of every aggregate, and the lifecycle events
of every process. `events.read` reads it a page at a time, on the app and on the client every host
gives:

```ts
const events = await app.events.read({ after: 0, limit: 100 });
```

## What a read returns

The events committed after the position `after`, in position order, at most `limit` of them.
Both are optional: `after` defaults to 0, the start of the stream, and `limit` to 100; it can be
anything from 1 to 1,000. A position that is negative or not a whole number, or a `limit` outside
that range, is refused with `ValidationError` (`VALIDATION_FAILED`), whose `issues` name the
field.

Each event comes whole, as the `StoredEvent` type of `@bounda-dev/core` describes it:

| Field | What it is |
| --- | --- |
| `position` | Its place in the global stream |
| `id` | The event's id |
| `aggregateType`, `aggregateId`, `version` | The stream it belongs to, and its place there |
| `type`, `payload` | What happened, with its data |
| `timestamp` | When it was stored, on the app's clock |
| `metadata` | `correlationId`, `causationId`, `commandId`, `depth`, `schemaVersion` and `system`: where it came from, as [Ids, causation and correlation](/concepts/ids-causation-and-correlation/) explains |

The lifecycle events of a process are rows like any other: `ProcessStarted`, `ProcessHandled`,
`ProcessCompleted` and the rest, with the instance's id as `aggregateId`, `system: true`, and
`process:<aggregate>.<process>` as `aggregateType`, so they never mix with an aggregate's.

**Payloads come as they were stored.** An event written before its type had an
[upcaster](/guides/changing-events/) keeps its old shape, and `metadata.schemaVersion` says
which; only handlers see it upcast. So a read shows what the store holds, and an event written by
newer code, which this code cannot upcast, does not make it fail. A field marked
[`personal`](/guides/personal-data/) comes as the store holds it too: an envelope with the
ciphertext and the person's id, never the value, so the stream can be read by an operator without
reading anyone's data. A `PersonalDataForgotten` event is a row like any other, on the stream
`bounda:<personId>` with `system: true`.

## Following the stream

A read never returns an event while one before it is still uncommitted, so reading on from the
last position returned never misses an event committed later. An empty page means nothing is
committed past that position yet: wait, and ask again from the same one.

```ts
import { setTimeout } from "node:timers/promises";

let after = 0;
for (;;) {
  const events = await app.events.read({ after });
  for (const event of events) console.log(event.position, event.aggregateType, event.type);
  after = events.at(-1)?.position ?? after;
  if (events.length === 0) await setTimeout(2_000);
}
```

That is polling, and the only way for now: nothing pushes new events to a reader. A page in the
browser does the same through a route of its own:

```ts
// app/routes/stream.ts, fetched by the page every few seconds with the last position it holds
import { bounda } from "@bounda-dev/react-router/app";
import { data } from "react-router";
import type { Route } from "./+types/stream";

export const loader = async ({ request, context }: Route.LoaderArgs) => {
  await requireOperator(request); // your authentication
  const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) throw data("Not a position", { status: 400 });
  return context.get(bounda).events.read({ after });
};
```

## Where it runs

- **On the app.** `app.events.read` on an app from `createApp`, `boot()` or `createTestApp`, in
  every role.
- **On Cloudflare.** `connect(stub).events.read`: the Durable Object answers it over RPC, a
  refusal included, and each read is one request to the object.
- **In React Router.** `context.get(bounda).events.read` in a loader or an action, on Node and on
  Cloudflare alike.

The JSON API of `createWorker` does not serve it: it has no operator endpoint.

## Who may read it

A payload holds whatever the domain put in it: names, emails, addresses. The read hands it over
whole, so it is for those who operate the app. A route that serves it sits behind the app's own
authentication, and one a visitor reaches shows only what that visitor may see, such as the
store of their own tenant.
