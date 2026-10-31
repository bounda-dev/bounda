---
title: Forgetting in an immutable log
description: What to do with personal data in events that are never deleted, when keeping it behind a port is enough, when crypto-shredding is the answer, and what Marten, Axon and KurrentDB do instead.
sidebar:
  order: 52
---

An event store keeps every event, forever. That is what makes a rebuild honest, an audit trail
complete and a bug reproducible. It is also what a privacy law such as the GDPR runs into head on:
a person may ask that their data be erased, and a log whose point is to never erase anything has
to answer. The answer is not to delete events. **Decide, for each field, whether it belongs in the
event at all, and when it does, make it unreadable instead of absent.**

## Most personal data does not belong in an event

An event records a decision of the domain. `OrderPlaced` is the fact that customer `c-42` placed
an order for two items; the customer's name, their address and their phone number are not part of
that fact. They are details the shipping provider needs, the invoice shows, the welcome email is
sent to. A command handler that puts them in the event because "they were in the command" has
made the event the owner of data that another part of the system owns.

The first tool is a port. The event carries the id and the data lives behind a port whose
implementation can delete:

```ts
// app/domain/customer/contact-details.ts
export interface ContactDetails {
  save(customerId: string, details: { email: string; phone: string }): Promise<void>;
  find(customerId: string): Promise<{ email: string; phone: string } | null>;
  erase(customerId: string): Promise<void>;
}
```

A command saves the details through the port and returns `CustomerRegistered { customerId }`; a
policy that sends the welcome email reads them through the port when it runs. Erasing the person
is `erase(customerId)` on the store the implementation writes to: a table, a KV namespace, a
profile service. On Cloudflare that store is another binding, a KV or D1 next to the Durable
Object, so the object's SQLite holds nothing to forget. Mathias Verraes calls this
[forgettable payloads](https://verraes.net/2019/05/eventsourcing-patterns-forgettable-payloads):
the event keeps a reference, the referenced data has a lifetime of its own.

This is enough when the data is not needed to replay the past: a rebuilt read model lists the
orders of `c-42` by id, and a query joins the current details through the port when it shows
them. It also keeps the data out of every copy of the stream: backups, the global stream an
operator reads, the events a policy of another aggregate receives.

## When the event has to carry it

Sometimes the data *is* the decision. `AddressChanged` records the address the customer moved to;
`EmailVerified` records which email was verified; a `ComplaintFiled` records what the customer
wrote. Leaving it out makes the event meaningless, and a projection that shows it would have to
call a port, which
[a projection never does](/concepts/projections-call-no-one/). Then the field stays in the
event, and forgetting it has to work on the event itself, in the log, in every backup, without
rewriting anything.

That is crypto-shredding, Verraes's
[throw away the key](https://verraes.net/2019/05/eventsourcing-patterns-throw-away-the-key/):
every person has a key, their fields are stored encrypted with it, and forgetting the person is
deleting the key. The events stay where they were, byte for byte; what they held is noise from
then on, in the live database and in every copy taken before. Bounda does this for you:

```ts
// app/domain/customer/address-changed.ts
import type { Event } from "./+types/address-changed";

export const payload = ({ z, personal }: Event.PayloadArgs) =>
  z.object({ address: personal(z.object({ street: z.string(), city: z.string() })) });
```

`personal` marks a field; the aggregate's id names the person, or a field marked with `person`
does when the event belongs to someone else's aggregate. `app.forget("c-42")` deletes the key
and appends `PersonalDataForgotten` to the person's own stream. The
[guide](/guides/personal-data/) has the rest: the types a forgotten field takes, what read models
have to do, and where the keys live.

## What forgetting changes for the rest of the app

Forgetting is an event of its own because what the log held has leaked, legitimately, into
everything that was built from it. A read model that projected the address has the address in a
row; a policy that sent it to the shipping provider gave it to a system of its own. Deleting the
key makes the event unreadable and does nothing to those.

So every read model that projects a personal field must also project `PersonalDataForgotten`,
and the generator fails the build of one that does not. The runtime's own copies are its job:
[snapshots](/concepts/long-streams/#snapshots), which hold an aggregate's state in the clear,
go with the key, in the same transaction. A policy on the same event is where the
outside world gets told: erase the contact at the mailing provider, delete the profile the search
index holds, as [keeping an external index](/guides/calling-the-outside-world/#keeping-an-external-index)
does on the way in.

And every handler that reads a personal field reads it as `T | null`. The `null` is not a style
choice: it is what makes the compiler find every place that assumed the data would always be
there, the projection that copied it into a `NOT NULL` column, the `evolve` that lower-cased it.
A forgotten person's events still fold, still project, still replay; they just carry a hole
where the data was.

## How others do it

- **Marten** rewrites. A masking rule per event type says how to change its members, and
  `ApplyEventDataMasking` runs it over the streams or tenant you choose, updating the stored rows
  in place; projections only show the masked values after a rebuild. There is no key: the
  erasure is destructive, which Marten's own documentation lists as the reason it is still
  considering crypto-shredding for a later version.
- **Axon** shreds. Its Data Protection module, a commercial add-on, marks fields with
  `@PersonalData` and the subject with `@DataSubjectId`, encrypts them on the way to the store,
  and `deleteKey(subjectId)` forgets. After that a `String` reads as a replacement value, `""` by
  default, other references as `null`, primitives as their default. Keys live in a crypto engine
  of its own: a JPA or JDBC table, Vault, a Java key store. Nothing tells the rest of the app
  that a key is gone.
- **KurrentDB**, EventStoreDB's successor, deletes streams. A soft delete hides a stream and
  lets it be reopened; a hard delete leaves a tombstone and the name can never be used again;
  `$maxAge` and `$maxCount` hide events by age or count. All of them hide at read time: nothing
  leaves the disk until a scavenge rewrites the chunks, started by an operator on every node, and
  the store keeps one event per stream to say it existed. Crypto-shredding is left to the
  application; Kurrent's own guidance on the GDPR is a blog post and a webinar.

Bounda's choice sits with Axon's, with three differences. The key is per person, in the same
database as the events, so that an adapter's backup and restore keep the two together and a test
needs no second store. The forgotten value is `null`, in the type as in the data, rather than a
replacement the type hides. And forgetting is an event, because the read models and the policies
have work to do when it happens.

## What stays outside

- **Data in the clear elsewhere.** A field marked `personal` in one event and left plain in
  another is readable through the second one. The mark is per field per event, so mark every
  event that carries the data, or carry it in one.
- **What left the store.** Backups of the key table, logs that printed a payload, the external
  systems a policy wrote to. The key store is a table like the others: a backup of the whole
  database restores the keys too, so a backup kept past a person's erasure is itself a copy of
  their data.
- **Scheduled commands and dead letters.** A command scheduled with `delay` is stored with its
  payload, in the clear, until it runs, and a dead-lettered scheduled command keeps it. Keep
  personal data out of delayed commands, or carry an id and resolve it when the command runs.
  A dead letter also keeps the error a handler threw, message and stack: one that quotes a
  decrypted field keeps it in the clear.
- **Encrypted data under the GDPR.** Whether a ciphertext without a key still counts as personal
  data is a legal question Verraes raises and this page does not answer.

## Where to read more

- [Personal data](/guides/personal-data/): the guide, with `personal`, `person`, `forget` and
  the read model's part.
- [Your projection should not call anyone](/concepts/projections-call-no-one/), for why the
  data a projection shows has to be in the event.
- Mathias Verraes,
  [Forgettable payloads](https://verraes.net/2019/05/eventsourcing-patterns-forgettable-payloads)
  and [Crypto-shredding](https://verraes.net/2019/05/eventsourcing-patterns-throw-away-the-key/).
- Marten's [protected information](https://martendb.io/events/protection), Axon's
  [data protection](https://docs.axoniq.io/axon-framework-reference/5.1/data-protection/) and
  KurrentDB's [streams](https://docs.kurrent.io/server/v25.0/features/streams) and
  [scavenging](https://docs.kurrent.io/server/v25.0/operations/scavenge).
