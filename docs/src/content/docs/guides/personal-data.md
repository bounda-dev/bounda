---
title: Personal data
description: Mark the fields of an event that hold personal data, say whose they are, forget a person with one call, and handle it in every read model that showed them.
sidebar:
  order: 11
---

Events are never deleted, so personal data in one is forgotten by making it unreadable: each
person has a key, their fields are stored encrypted with it, and `forget` throws the key away.
[Forgetting in an immutable log](/concepts/forgetting-in-an-immutable-log/) says when to do this
and when to keep the data behind a port instead. This page is the how.

## Marking a field

An event's `payload` receives `personal` and `person` next to `z`:

```ts
// app/domain/customer/customer-registered.ts
import type { Event } from "./+types/customer-registered";

export const payload = ({ z, personal }: Event.PayloadArgs) =>
  z.object({ email: personal(z.email()), plan: z.enum(["free", "pro"]) });

export const begin = ({ event }: Event.BeginArgs) => ({
  email: event.payload.email,
  plan: event.payload.plan,
});
```

`personal(schema)` takes any schema: a string, a number, a whole object or an array, which is
encrypted as one value. It marks a top-level field of the payload; a mark deeper down is not seen,
so mark the field that holds the nested object. Here the person is the aggregate itself: the key
is the customer's id. When the event belongs to another aggregate, `person` names the field that
identifies them:

```ts
// app/domain/order/order-placed.ts
import type { Event } from "./+types/order-placed";

export const payload = ({ z, personal, person }: Event.PayloadArgs) =>
  z.object({
    customerId: person(z.string()),
    lines: z.array(z.object({ sku: z.string(), quantity: z.int().positive() })),
    deliveryNote: personal(z.string()).optional(),
  });
```

An event names at most one person. Only events have the marks: a command's or a query's
`PayloadArgs` has no `personal`, since commands are not stored and nothing of theirs has to be
forgotten.

## What the types say

Whoever writes the event, the command handler through `events.customerRegistered({ email })`,
passes what the schema takes: a `string`. Whoever reads it, `begin`, `evolve`, a policy, a
projection, a process, sees `string | null`: the value, or `null` once the person is forgotten.
The `null` reaches the state too, so the `begin` above gives the customer an `email` of
`string | null`, and a command handler that reads `state.email` handles the case. A field
marked `.optional()` reads as `string | null | undefined`: absent, or forgotten.

An [upcaster](/guides/changing-events/) runs on the payload after it is decrypted, so one that
reads a personal field of an old shape must take `null` there too.

## Forgetting a person

```ts
const forgotten = await app.forget("c-42");
await app.catchUpReadModels({ through: forgotten });
```

`forget` is on every `BoundaClient`: the app, the Durable Object through `connect`, the `bounda`
context of React Router. In one transaction it deletes the person's key and appends
`PersonalDataForgotten`, with `{ personId }` as payload, to the stream `bounda:<personId>`: the
runtime's own aggregate, `bounda`, has one stream per person it forgot. It resolves like a
command, with the event's position, so `catchUpReadModels({ through })` waits for the read
models that handle it, and the Durable Object's `forget` waits for them itself unless
`consistency` is `"eventual"`. A person without a key is forgotten all the same, since a read
model may hold what their events carried in the clear, and forgetting twice appends twice. An
empty id is refused with `ValidationError`.

From then on every personal field of theirs reads as `null`, in every event, however old. A
person registered again gets a fresh key; their old events stay unreadable. A command that loaded
their data before `forget` and appends after it never writes that data back, not even under the
fresh key another command gave them meanwhile: the state it loaded remembers the key each
person's data was read under, and an append that would seal their fields under any other fails
with [`ConcurrencyError`](/reference/errors/), as on a stream that moved. The retry decides on the
state without their data.

A [snapshot](/concepts/long-streams/#snapshots) holds the state in the clear, so the same
transaction removes every snapshot whose state carried a field of theirs; each one names the
people it holds and the key it read each one under, and none is written for a person who no
longer holds that key. The next command on such an
aggregate folds it from its first event, with the fields forgotten, and the snapshot after it
holds them as `null`.

A command dispatched with an [`idempotencyKey`](/guides/idempotent-commands/) remembers
what it answered, and a rejection's message may quote the state it was decided on. Such a
rejection names the people whose fields were in that state, with their keys as a snapshot does,
and `forget` removes it too: the same request sent again is decided again, on the state without
them. What it cannot see is personal
data that came in the command's payload, which is never marked: keep that out of a rejection's
message and say what went wrong with its code and the ids involved.

## Handling it in a read model

A read model that projects an event with personal fields has those fields in its rows. It must
project `PersonalDataForgotten` from `projections/bounda/personal-data-forgotten.ts`:

```ts
// app/read/customer-directory/projections/bounda/personal-data-forgotten.ts
import type { Projection } from "./+types/personal-data-forgotten";

export const project = async ({ event, table }: Projection.Args) => {
  await table.delete({ customerId: event.payload.personId });
};
```

What it does is the read model's business: delete the row, as here, keep it without the personal
columns by upserting it again without them, or keep a count. The
generator checks it: `.bounda/types.ts` declares one type per read model,
`CustomerDirectoryForgetting`, that fails to compile while the read model projects an event with
personal fields and has no such projection, naming the read model and the file to add. A read
model whose projections never see a personal field needs nothing.

A projection of a personal event handles `null` as well, since a rebuild replays every event, the
forgotten ones included: a `string` column that is `NOT NULL` takes a `null` email badly, so make
the column optional and leave it out, as the directory above does.

## Telling the outside world

What a policy sent out stays out: the mailing provider has the contact, the search index has the
profile. A policy in `policies/bounda/` reacts to the event:

```ts
// app/domain/customer/policies/bounda/erase-on-personal-data-forgotten.ts
import type { Policy } from "./+types/erase-on-personal-data-forgotten";

export const handler = async ({ event, mailer, idempotencyKey }: Policy.HandlerArgs) => {
  await mailer.eraseContact(event.payload.personId, idempotencyKey);
};
```

It runs with the aggregate's ports, retries and dead-letters as any policy, and its handler is
typed with `PersonalDataForgottenEvent`.

## Where the keys live

Each adapter keeps the keys in a table next to the events, `bounda_personal_keys`, one row per
person with the key and its fingerprint, a SHA-256 of it: the memory adapter in memory, SQLite and the Durable Object in their database, PostgreSQL
in its schema. A key is created when the first event with a personal field of that person is
stored, by the transaction that stores it, and deleted by `forget`. Encryption is AES-256-GCM
through WebCrypto, with a nonce per value, on Node and in `workerd` alike; what the store holds
for a personal field is an envelope with the ciphertext, the person's id and a fingerprint of the
key, which the [global stream](/guides/reading-the-stream/) shows as it is; a value sealed under a
key the person no longer has, because they were forgotten and registered again, reads as `null`
next to what their new key opens.

Keeping the keys next to the data is a choice: a backup restores both, a test needs nothing
else, and the Durable Object has no second store to reach. It also means a backup is a copy of
the data for as long as it is kept, and that whoever reads the database reads the keys. An
adapter is free to keep them elsewhere: `Storage.personalKeys` and the key store's
[contract](/adapters/) are the whole interface.

## In tests

`createTestApp` forgets like any app:

```ts
const { app } = await createTestApp({ registry });
await app.commands.registerCustomer({ customerId: "c-1", email: "ana@example.com", plan: "pro" });
await app.forget("c-1");
await app.runUntilIdle();
expect(await app.queries.getCustomer({ customerId: "c-1" })).toEqual({ customerId: "c-1" });
expect(JSON.stringify(await app.events.read())).not.toContain("ana@example.com");
```

The second assertion is the one that matters: the stream, read raw, holds nothing of the person.
