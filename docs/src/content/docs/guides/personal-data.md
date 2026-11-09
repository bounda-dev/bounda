---
title: Personal data
description: Mark the fields of an event, a process state or a read model that hold personal data, say whose they are, seal what was written before a field was marked, forget a person or export their data with one call, record who opened whose data, forget them after a retention or when a purpose ends, wrap their keys under a master key kept out of the database, handle forgetting in every read model that showed them, and check in a test that nothing of a forgotten person is left readable.
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

An event names at most one person.

## In a command's payload

A command is stored too when it waits: dispatched with `delay`, retried by the scheduler after a
failure, or dead-lettered once it gives up. A command that carries personal data marks its payload
the same way, with `personal` and `person` from its own `PayloadArgs`:

```ts
// app/domain/customer/commands/remind-customer.ts
import type { Command } from "./+types/remind-customer";

export const payload = ({ z, personal }: Command.PayloadArgs) =>
  z.object({ customerId: z.string(), email: personal(z.email()) });
```

Wherever the command is stored, the marked fields are encrypted with the key of the person it
names, the aggregate's id or the field marked `person`, and [`forget`](#forgetting-a-person)
cancels it. A command dispatched at once is never stored, so the marks change nothing for what it
stores; `person` still says whom it touches, which [restricting their
processing](#restricting-processing) goes by, so a command may mark a `person` field alone. So
may an event: it then names its person as one with personal fields does, for the
[export](#exporting-a-persons-data), and is refused with `ValidationError` when that field is
empty. The
handler reads `command.payload.email` as a `string`, never `null`: a command whose person is
forgotten never runs. A query's `PayloadArgs` has no `personal`, since a query is never stored.

A command scheduled before its fields were marked is sealed in place by the
[backfill](#marking-a-field-later), and `forget` finds it from then on.

## In a process's state

A [process](/guides/reacting-to-events/) keeps its state in the lifecycle events of its own
stream, so a state that holds personal data marks it the same way, with `personal` and `person`
from its `StateArgs`:

```ts
// app/domain/signup/processes/onboarding/index.ts
import type { Process } from "./+types/index";

export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.signup.SignupStarted],
  completedBy: [events.signup.SignupConfirmed],
});

export const state = ({ z, deadline, personal, person }: Process.StateArgs) =>
  z.object({
    customerId: person(z.string()).nullable().default(null),
    email: personal(z.email()).nullable().default(null),
    reminder: deadline(),
  });
```

Every lifecycle event that carries the state stores its marked fields encrypted with the key of
the person the state names: the field marked `person`, or, when none is marked, the instance's
id while a personal field holds a value, as an event's aggregate id is. A state learns whose it is
in a later step, so it starts naming nobody: its `personal` and `person` fields default to `null`,
and the app does not start otherwise. While its `person` field is `null` it names nobody, and a
step that sets a personal field with nobody named fails with `ValidationError`, as a terminal
error. A personal field holding `null` holds nothing of theirs and is stored as it is.

Once the person is forgotten, those fields read as `null` and the instance carries on: its
handlers and deadlines run on the rest of the state, and the types say so, `string | null` for
`email` whatever its schema. The schema takes `null` for a personal field too, so a handler may
clear one itself. Only the marked fields are encrypted, never the whole state, which would leave
an instance unable to go on once its person is forgotten.

The rest follows from the stream: the [export](#exporting-a-persons-data) lists the lifecycle
events that name the person, with the fields of the state they carry; while their processing is
[restricted](#restricting-processing), a step of the instance is refused before its handler runs;
and a step that fails has its error text encrypted with the key of the person its event names,
or else of the one the state names, which covers a deadline. A lifecycle event written before its
state marked its fields is sealed in place by the [backfill](#marking-a-field-later).

## What the types say

Whoever writes the event, the command handler through `events.customerRegistered({ email })`,
passes what the schema takes: a `string`. Whoever reads it, `begin`, `evolve`, a policy, a
projection, a process, sees `string | null`: the value, or `null` once the person is forgotten. So does a process handler that
reads a personal field of its own state.
The `null` reaches the state too, so the `begin` above gives the customer an `email` of
`string | null`, and a command handler that reads `state.email` handles the case. A field
marked `.optional()` reads as `string | null | undefined`: absent, or forgotten.

An [upcaster](/guides/changing-events/) runs on the payload after it is decrypted, so one that
reads a personal field of an old shape must take `null` there too.

## Marking a field later

A field marked after events were written finds those events holding it in the clear, and naming
nobody. The runtime fixes that in the background: the worker walks the whole stream from its first
event and seals, in place, each value a field marked now holds in the clear, with the key of the
person the marks name, who becomes the event's person. Then it does the same for the payloads of
scheduled commands and dead letters, and for the error text of a policy's or a process's dead
letter that failed before the marks, whose work names someone now. From then on `forget`, the
[export](#exporting-a-persons-data) and [restricting](#restricting-processing) reach that data as
if it had been marked from the start. Nothing to configure, nothing to run: it starts when an app
whose schemas mark anything starts, and the lifecycle events of a process, whose state marks its
fields the same way, are part of the stream it walks.

It walks once per set of marks. Its position is kept under a fingerprint of every mark of the
registry, so adding, removing or moving one walks the stream again from the start, and a restart
with the same marks walks nothing twice. Once it reaches the head it goes through the scheduled
commands and dead letters, and from then on reads what comes after once a minute: an instance still
running the old marks, as in a rolling deploy, writes in the clear for a while, and what it writes
is sealed that much later, the stores included. One instance walks at a time, under a lease kept in
`bounda_checkpoints`; a batch that fails, because the [key wrapper](#where-the-keys-live) does not
answer, say, holds the walk for every instance, 30 seconds and twice as long after each failure in
a row, up to an hour, and the worker logs it.

A person forgotten before the marks were added has no key to seal with, and creating one would make
what their forgetting should have covered readable again. What an event held of them before their
last forgetting is sealed under a key no store keeps, and reads as `null`, as if it had been marked
then; what came after, once they were registered again, is sealed under the key they hold now. A
scheduled command or a dead letter of a person who holds no key and was forgotten gets the same, and
the text of an error never gets a new key, as when a handler fails. The worker logs `personal data of
persons forgotten before it was marked is sealed for good; rebuild the read models that project it`
with the event types: a read model that showed those fields keeps what it projected before the
forgetting reached them, and a [rebuild](/guides/deployment/#rebuilding-a-read-model) replays the events with
them forgotten. No other read model needs one: sealing changes how an event is stored, never what it
reads as. A snapshot folded from fields in the clear is dropped with the batch that seals its stream,
since it names nobody a `forget` would remove it for, and the next command folds the stream again.

What it cannot seal stays as it was, and the worker says so: a value in the clear in an event whose
`person` field is empty, `personal data written before its marks names no person and stays in the
clear`, with the event types, and a scheduled or dead-lettered command whose `person` field is
empty, `commands stored before their marks name no person and stay in the clear`. The
marks are read on the payload as stored, below the [upcasters](/guides/changing-events/), so a field
an upcaster renamed or computed is sealed under the name it was stored with, or not at all when it
was never stored; an event whose `person` field changed since it was sealed keeps the person it was
sealed for. A rejection remembered under an [`idempotencyKey`](/guides/idempotent-commands/) before
the marks names nobody and lasts until its key expires, a day by default. A person whose processing
is restricted has their data sealed all the same: sealing protects it, and processes nothing.

`app.getLag()` reports where the walk stands, `personalDataBackfill: { position, caughtUp }`, `null`
for an app that marks nothing: `caughtUp` once the walk has sealed the stream up to its head and
every scheduled command and dead letter as the marks of now say, which is when an export or a
`forget` reaches everything; what is written after is sealed as it is written, and an instance
still on older marks makes it `false` again until the walk has sealed what that instance wrote. The worker logs `personal data written before its marks is sealed` with what it
sealed once the walk catches up, and each batch it seals is a [`bounda.backfill`
span](/reference/observability/). When retention is configured, a person an event names only once
it is resealed has that event recorded as their last activity, so the [retention](#retention) forgets
them in their time.

## Forgetting a person

```ts
const forgotten = await app.forget("c-42");
await app.catchUpReadModels({ through: forgotten });
```

`forget` is on every `BoundaClient`: the app, the Durable Object through `connect`, the `bounda`
context of React Router. A client bound with `as` records who asked on `PersonalDataForgotten`, in
`metadata.actor`, and so on `ProcessingRestricted` and `ProcessingRestrictionLifted`. In one transaction it deletes the person's key, cancels the scheduled
commands that hold their data, removes the dead letters of those that gave up, and appends
`PersonalDataForgotten` to the stream `bounda:<personId>`: the runtime's own aggregate, `bounda`,
has one stream per person it forgot. Its payload is `{ personId, reason, fingerprints,
cancelledCommands, removedDeadLetters }`: `reason` is `"requested"` for `forget` and
`"retention"` when the [retention](#retention) forgot them, `fingerprints` names the key it
destroyed, by its check value, which opens nothing, none for a person who held none, and the rest
are the ids and types of what went, the only record of commands that never became events. A
forgetting a [forget ledger](#backups) commits again keeps its id, its time and its reason. It resolves like a command, with the event's
position, so `catchUpReadModels({ through })` waits for the read models that handle it, and the Durable Object's `forget` and the one in React
Router's `bounda` context wait for them themselves unless `consistency` is `"eventual"`. A person
without a key is forgotten all the same, since a read model may hold what their events carried in
the clear, and forgetting twice appends twice. An empty id is refused with `ValidationError`.

From then on every personal field of theirs reads as `null`, in every event, however old. A
person registered again gets a fresh key; their old events stay unreadable. A command running
when `forget` commits stores nothing it decided on their data, nor anything sealed under the key
`forget` removed: the state it loaded remembers the key each person's data was read under, its
events name the key they seal each person's fields under, and the store appends them only while
every one of those people still holds that key, checked in the append's own transaction. A
`forget` that commits first makes the append fail with
[`ConcurrencyError`](/reference/errors/), as on a stream that moved, even when another command
gave the person a fresh key meanwhile; the retry decides on the state without their data, and
seals what it writes of them under their fresh key, as for someone registered again.

A scheduled command already running when `forget` comes writes nothing: its claim is gone, so
neither its events nor a dead letter are stored, though its handler may have run. One that a
`forget` misses, stored in the instant between reading the key and the key going, is sealed under
a key no one holds: it is dropped when it comes due, unrun, and the worker logs `scheduled command
dropped: its person was forgotten`. The [dead letters](/guides/dead-letters/) list shows a
scheduled command's payload with its fields opened.

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
data that came in the command's payload, marked or not: keep that out of a rejection's
message and say what went wrong with its code and the ids involved.

The message of an error a handler throws may quote a personal field it read, so a [dead
letter](/guides/dead-letters/#what-a-letter-holds) keeps the message and the stack encrypted with
the key of the person its work names, and `forget` leaves the letter in place with them reading as
`null`. The key is the one the work read their data under: a person forgotten while the handler
was failing, and given a fresh key before it gave up, has the text encrypted under a key nobody
keeps, so it reads as `null` too instead of opening under the fresh key; the stream's `ScheduledCommandFailed` and `ProcessFailed` name the error's class and code
and never its text, and so does the last error the inbox and the scheduler keep of a claim.

The runtime's own log lines and spans carry no error's text: an error is logged and traced by its
class, its code and the ids of what failed, and the line that files a dead letter names the letter,
whose text `app.deadLetters` opens for as long as the person is not forgotten. Only
[`runtime.telemetry.errorText: "include"`](/reference/observability/#error-text) puts the message
and the stack there, in the clear, out of `forget`'s reach: keep it to development.

What `forget` does not reach is text your code writes elsewhere and data left unmarked: your logs
keep whatever you wrote to them, an event's payload written in the clear, with the data in a field
you did not mark, stays readable, a command's payload left unmarked is stored as it came, and the
error of work that names nobody, such as a deadline of a process whose state names nobody or a
scheduled command whose payload marks nothing, stays in its dead letter in the clear. Log and throw with ids, not the data itself,
and mark every field that holds it. A letter retried or discarded keeps its text until
[`runtime.deadLetters.retention`](/guides/dead-letters/#keeping-resolved-letters) removes it, sealed
or not; set it to bound how long that is.

Nor does it reach the `actor` in the metadata of events, who acted on them (see
[Who acts](/concepts/ids-causation-and-correlation/#who-acts)): it is an id, as a person's id is,
so bind clients with the id of a user or a service, never their name or email.

## Exporting a person's data

```ts
const exported = await app.exportPersonalData("c-42");
```

`exportPersonalData` is on every `BoundaClient` too: the app, the Durable Object through
`connect`, the `bounda` context of React Router. It answers what the store holds that names the
person, for them to take away, as the right of access and the right to portability ask:

```ts
{
  personId: "c-42",
  exportedAt: "2026-03-01T10:00:00.000Z",
  events: [
    { id, type: "CustomerRegistered", aggregateType: "customer", aggregateId: "c-42",
      version: 1, position: 17, timestamp, data: { email: "ana@example.com" } },
    { id, type: "OrderPlaced", aggregateType: "order", aggregateId: "o-9",
      version: 1, position: 40, timestamp, data: { deliveryNote: "ring twice" } },
  ],
  scheduledCommands: [{ commandId, type: "RemindCustomer", executeAt, data: { email } }],
  deadLetters: [
    { id, kind: "policy", handler: "customer.welcomeOnCustomerRegistered",
      errorMessage: "no mailbox for ana@example.com", errorStack, data: {} },
  ],
  readModels: {
    customerDirectory: [{ key: "c-42", data: { email: "ana@example.com" } }],
    orderSummary: [{ key: "o-9", data: {} }],
  },
}
```

`events` are every event that names the person, by its field marked `person` or its aggregate's
id, in position order, the events of their own stream `bounda:<personId>` included; `data` holds
the fields marked `personal` of that event, opened, and nothing else of its payload, so an event
without such fields has an empty `data`. A process's lifecycle event names the person [its state
names](#in-a-processs-state), and its `data` holds the personal fields of that state. `scheduledCommands` are the commands waiting to run
whose payload holds personal fields of theirs, with `commandId` the id the dispatch answered or,
for one the runtime scheduled itself, the scheduler's key, each with the same `data`.
`deadLetters` are the handler runs that gave up and name the person: work about them, whose
`errorMessage` and `errorStack` are encrypted with their key and come out opened, and the
scheduled commands whose payload holds their fields, with its `data`. After `forget`, the
person's events and letters are still theirs, and every field and error text reads as `null`, as
a handler reads it. `readModels` has an entry for every read model with a field marked
[`.person()`](#personal-data-in-read-models): the rows whose person field holds the id, each
with its primary key as `key`, so the person can tell them apart, and its fields marked
`.personal()` as `data`, read through the read model's own storage, which may be another
adapter's, in pages by primary key, so a projection that writes a row meanwhile cannot make
another skip or repeat. An empty id is refused with `ValidationError`.

Only what is marked comes out, and that is the limit to know: a field left unmarked is not
personal data to Bounda, so the rest of `OrderPlaced` is the order's and stays out; a read model
without a person field is a view Bounda cannot tell is about anyone, and whatever a policy sent
out is at the mailing provider or the search index. An app that owes a person more than their
marked fields takes this export and adds what it knows from its ports. An event stored before its
type marked its fields is found once the [backfill](#marking-a-field-later) has sealed it.

Each store keeps the person an event names in a `person` column, indexed with the position, and
the adapters read by it with `readByPerson`; a scheduled command is found by the `persons` it
carries, and a dead letter by its `person` or its `persons`. `forget` and the export find those
rows, and the snapshots and remembered rejections `forget` removes, through an index, never by
reading every row: PostgreSQL indexes the `persons` column itself, and SQLite, the Durable Object
included, keeps a table of which row names which person, written and removed by the same statement
as the row.

## Personal data in read models

A read model that projects an event with personal fields has copies of them in its rows. Its
view marks them, as an event's payload does, with two methods of the field builder:

```ts
// app/read/customer-directory/view.ts
import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  customerId: f.string().primaryKey().person(),
  email: f.string().optional().personal(),
  plan: f.string(),
});
```

`.personal()` marks a column that holds personal data; `.person()` marks the one that holds the
id of the person the row is about, a `string` column, at most one per read model. They are
methods of the field, next to `.index()`, because a read model's columns are declared there; a
person who appears in many rows, such as a customer in an order summary, is marked on that
foreign column (`customerId: f.string().index().person()`), with its own index if the export of
a person with many rows must be fast. The marks change nothing about how the adapter stores the
column. They do three things: the person's [export](#exporting-a-persons-data) includes the rows
that name them, a [query](#who-opened-what) of a read model with personal fields is recorded in
the access log, and the generator checks forgetting by them.

Every read model that keeps personal data must project `PersonalDataForgotten` from
`projections/bounda/personal-data-forgotten.ts`:

```ts
// app/read/customer-directory/projections/bounda/personal-data-forgotten.ts
import type { Projection } from "./+types/personal-data-forgotten";

export const project = async ({ event, table }: Projection.Args) => {
  await table.delete({ customerId: event.payload.personId });
};
```

What it does is the read model's business: delete the row, as here, keep it without the personal
columns by upserting it again without them, or keep a count. The generator checks it:
`.bounda/types.ts` declares one type per read model, `CustomerDirectoryForgetting`, that fails to
compile, naming the read model and what to add, while the read model marks more than one field
with `.person()`, marks fields with `.personal()` and none with `.person()`, or has fields marked
`.personal()` or projects an event with personal fields and has no projection of
`PersonalDataForgotten`. The app refuses to start on the same marks with `ConfigurationError`,
for a project that skipped the type check. A read model that projects personal events and marks
nothing is still checked for forgetting, and nothing more: Bounda cannot tell whether it kept a
copy, and one that keeps only the order's total must not be made to mark anything. A person field
alone holds an id, as events do, and needs no forgetting.

A projection of a personal event handles `null` as well, since a rebuild replays every event, the
forgotten ones included: a `string` column that is `NOT NULL` takes a `null` email badly, so make
the column optional and leave it out, as the directory above does.

## Who opened what

Accountability asks to know who opened whose personal data. Every operation that hands out a
person's data in the clear records it, once per call:

| Operation | `persons` | `detail` |
| --- | --- | --- |
| `exportPersonalData` | the person | `{ events, scheduledCommands, deadLetters, readModelRows }`, how many of each; `null` when it failed |
| `deadLetters.list` | those the letters name | `{ letters }`, how many |
| `deadLetters.get`, `retry`, `discard` | those the letter names | `{ letter }`, its id |
| a query of a read model with fields marked `.personal()` | those the `person` field names in the rows the query read | `{ query, readModel }` |

Each record is `{ operation, actor, persons, personCount, at, outcome, detail }`, and a query's
adds `unattributed`: `actor` is the client's, from
[`as`](/concepts/ids-causation-and-correlation/#who-acts), and `null` for a client that names
nobody; `persons` names each person once, in the order read, and at most `MAX_ACCESS_PERSONS` of
them, with `personCount` saying how many there were in all, so a query that lists every customer
gives a bounded record; `at` is the app's clock; `outcome` is `ok` when the call handed its result
out and `failed` when it rejected after reading, since its error may quote what it read, as a
handler's `cannot reach ana@example.com` does.

A query is matched to its read model by the module's place, and to its persons by the rows it
read through its `table` or `client`, in `repository` and `handler` alike, not by its result: a
handler that reshapes the rows into another object still handed their data out. So a query that
reads rows and answers only a count is recorded too, with those persons, and one that only calls
`table.count()` is recorded with none. A query whose `repository` or `handler` throws is
recorded as `failed`, with the persons of the rows it read until then. A query that takes
`client.raw`, the driver itself, reads rows Bounda cannot see: it is recorded with
`unattributed: true`, which says that `persons` names only those of the rows read through `table`
and `client`, and whose rows it read through the driver is unknown. A query that composes another
records nothing of its own unless its read model has personal fields; the one it calls records
itself, as the same actor. A query receives that actor too, in its `repository` and its `handler`,
so it can read only what whoever asks may see: see [Queries](/guides/read-models/#queries). What
the log does not see is in [Limitations](/reference/limitations/#the-access-log).

Without anything more, each record goes to the app's logger at `info`, with the message
`personal data accessed` and the record as its fields. Where it should go instead, a log pipeline
kept apart, a SIEM, a table in another database, is `app/audit.ts`:

```ts
// app/audit.ts
import type { OnPersonalDataAccess } from "@bounda-dev/core";

export const onPersonalDataAccess: OnPersonalDataAccess = async ({ access, env }) => {
  await fetch(env.AUDIT_URL, { method: "POST", body: JSON.stringify(access) });
};
```

The generator puts it in the registry, which checks it against `AuditModule`, and the app refuses
to start when it does not export the function, so every host gets it: `boot()`, `createApp`, the
Durable Object, React Router. It receives the record with the host's `env`, the `tenant` and the
app's logger, as a port's `create` does. A test app never calls it: `createTestApp` sends the
records to its `logger`, or to the `onPersonalDataAccess` the test passes. It runs once the call
has read and before it settles, whether it then hands its result out or rejects, and the call
waits for it. When it throws, the call rejects with that error, handing out neither its result
nor its own error: data handed out without its record is what an access log exists to rule out,
so a sink that is down stops the reads it would have recorded. A retry or a discard of a dead
letter acts first, so that its record can say how it went: with the sink down, the retry or the
discard is done, and the call still rejects without the letter. A hook that would rather let the
reads through catches its own failure and keeps the record somewhere else.

The records are never sampled, unlike a trace, and nothing is written to the store by default:
it would be a write on every read, and a record that names a person is personal data that
`forget` would then have to reach. A logger that drops `info` drops them too.

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

## Restricting processing

A person may ask that their data be kept but not processed for a while, the GDPR's restriction
of processing, while a dispute about it is settled. `restrict` is on every `BoundaClient`, next
to `forget`:

```ts
const restricted = await app.restrict("c-42");
await app.catchUpReadModels({ through: restricted });
```

In one transaction it writes the person's row in `bounda_persons` and appends
`ProcessingRestricted` to the stream `bounda:<personId>`, and it resolves like a command, so
`catchUpReadModels({ through })` waits for the read models that handle it, and the Durable Object
and React Router wait for them themselves unless `consistency` is `"eventual"`. Restricting a
person restricted already appends nothing and resolves without events. An empty id is refused
with `ValidationError`.

From then on every command that touches the person is refused with
[`ProcessingRestrictedError`](/reference/errors/) (`PROCESSING_RESTRICTED`, with the id in
`personId`) before it runs, and before it is scheduled when it has a `delay`: a command whose
payload names them with `person`, or whose aggregate is the person, that is when the command's
payload or any event of the aggregate marks a field without `person`. A command that names them
nowhere Bounda cannot tell is theirs, so mark the `person` field of every command that acts for
someone. `app.commands` throws the refusal; nothing is recorded under an `idempotencyKey`, so the
same request sent once the restriction is lifted runs. A command already running when `restrict`
commits is refused all the same: the store checks, in the transaction that would write its
events, that nobody they touch is restricted, so the two are ordered one before the other and its
events are never stored after the restriction. Its events touch the person the command names and
every person whose fields they seal, so a command for someone else whose events copy a restricted
person's marked fields is refused too.

A policy, process or scheduled command whose command is refused this way becomes a dead letter at
once, as for any terminal error, with `errorCode: "PROCESSING_RESTRICTED"` and the person in
`person`, even when the event it handled names nobody: a policy on `Invited`, an event of the
newsletter, dispatching `registerCustomer` for the restricted customer. So does a step of a
process instance whose [state names the person](#in-a-processs-state), before its handler runs,
and the store refuses a lifecycle event that would encrypt their fields as it refuses a command's.
A failed process parks what follows, as [it always does](/guides/dead-letters/#a-failed-process). Reading the person's
data, `forget` and the export of their data stay allowed: a restriction is not an erasure.

`unrestrict` lifts it:

```ts
const lifted = await app.unrestrict("c-42");
```

It clears the row, appends `ProcessingRestrictionLifted` the same way and schedules a run of the
worker that retries, in order, every `failed` dead letter the restriction caused, each as
[`app.deadLetters.retry`](/guides/dead-letters/#retrying-and-discarding) would, so the policies
run, the processes resume and the scheduled commands are dispatched, without an operator. A letter
that fails again for good stays `failed`, as that failure's letter, for the operator; one that
fails in a way worth retrying, a timeout or a store that does not answer, stays as it was and the
run is retried with the [retry settings](/reference/configuration/#retry) of policies; one refused
because the person is restricted again waits for the next lift. Lifting for a person
not restricted appends nothing and resolves without events.

Handling the two events is optional. A read model may project them from
`projections/bounda/processing-restricted.ts` and
`projections/bounda/processing-restriction-lifted.ts`, to show the person as restricted where
customer service looks, and a policy may react from
`policies/bounda/<action>-on-processing-restricted.ts`, to tell the outside world. Both carry
`{ personId }` and are typed `ProcessingRestrictedEvent` and `ProcessingRestrictionLiftedEvent`.

## Retention

The GDPR's storage limitation asks that personal data be kept no longer than its purpose needs.
Bounda covers the two ways a purpose ends: a person who stops coming back, and something the
domain decides.

### Inactivity

```ts
// bounda.config.ts
export default defineConfig({
  storage: sqlite({ path: "./data/app.db" }),
  runtime: { personalData: { retention: "730d" } },
});
```

With `runtime.personalData.retention` set, the runtime forgets a person no event has named for that
long, as `forget` does, with `reason: "retention"` in `PersonalDataForgotten`. There is no default:
without it nobody is forgotten for inactivity. The setting is app-wide, with no override per
aggregate, because a person's events span aggregates: a customer who places an order is active, as
a customer, whatever aggregate the order is.

Activity is an event of the app's aggregates that names the person, by its field marked `person`
or its aggregate's id, as the [export](#exporting-a-persons-data) finds them. The runtime's own
events on `bounda:<personId>` are not activity: restricting or lifting a restriction does not
start the clock again, and neither does forgetting, which the runtime records instead. A person
active again after being forgotten starts a new clock from that activity; their old events stay
unreadable. A person whose processing is [restricted](#restricting-processing) is left alone
while the restriction lasts, since keeping their data is what they asked for, and is forgotten
once it is lifted if they are due by then.

No timer is armed per person. A subscriber of the dispatcher, `retention`, follows the stream from
its first event and records in `bounda_persons` when each person was last active and last
forgotten, with its own checkpoint, in batches, like any subscriber; it shows in the lag, and
started over from the first event it records the same rows. Every pass of the scheduled-command
worker then sweeps: an indexed read of the persons whose last activity is older than the
retention, not restricted and not forgotten since, a bounded batch of them each forgotten in a
transaction of its own. The deadline is worked out at sweep time from the setting, so changing it
applies at once, to everyone, and turning it on applies it to the history: whoever was already
inactive for that long is forgotten in the first passes. A person named by an event the subscriber has not recorded yet is
left for a later pass, read in the transaction that forgets them, so nobody is forgotten for an
activity the row does not show yet, nor twice when two workers sweep at once; an event stored in
a transaction running beside it may still be forgotten with them, as one a command stores while
`forget` runs may be. A person the sweep could not forget, because their forget failed or their
row is behind, waits on their own, half a minute at first and twice as long after each failure up
to an hour, while the pass goes on with the next ones. The wait is kept on their row in
`bounda_persons`, written only when an attempt does not succeed, so every instance skips them
until it ends and a restart backs off from where it was; their next activity, or their
forgetting, clears it. `nextDueAt()` names the end of that wait, so a host never wakes for them
again at once. A database that cannot keep the wait, read-only after a failover say, pauses the
sweep in that instance instead, for as long and growing the same way.

A host without a polling worker learns of it from `app.nextDueAt()`, which names the earliest
retention deadline with the scheduled commands, so a [Durable Object](/adapters/cloudflare/)
arms its alarm for it.

### End of purpose

The domain knows when a purpose ends, so a [process](/guides/sagas/) decides: "forget the customer
30 days after their account closed, unless it reopens" is a process started by `AccountClosed`,
completed by `AccountReopened`, with a timeout of 30 days whose handler forgets them.

```ts
// app/domain/customer/processes/erasure/index.ts
import type { Process } from "./+types/index";

export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.customer.AccountClosed],
  completedBy: [events.customer.AccountReopened],
  timeout: "30d",
});
```

```ts
// app/domain/customer/processes/erasure/at-timeout.ts
import type { Process } from "./+types/at-timeout";

export const handler = async ({ aggregateId, forget }: Process.DeadlineArgs) => {
  await forget(aggregateId);
};
```

Policies and processes receive `forget(personId)` in their arguments, next to `commands`. It
forgets as `forget` on the app does, with `reason: "requested"`, inside the run's own unit of work:
the forgetting commits with the run's commands and its step, in the same transaction, or not at
all, so a run that fails and is retried forgets once. It resolves at once, before the commit, and
rejects an empty id with `ValidationError`. The `PersonalDataForgotten` it appends is caused by the
event the handler reacted to, one hop deeper, as its commands are.

### One key per person

Each person has one key, so their marked fields are forgotten together. "Keep the invoices six
years, the profile thirty days" does not fit one key: put the profile in marked events, which the
retention or a process forgets, and keep what the law makes you hold longer, such as an invoice,
behind a [port](/guides/calling-the-outside-world/) with a retention of its own, or in events whose
fields you do not mark.

## Where the keys live

Each adapter keeps the keys in a table next to the events, `bounda_personal_keys`, one row per
person with the key, the id of the key it is wrapped under and its fingerprint: the memory adapter
in memory, SQLite and the Durable Object in their database, PostgreSQL in its schema. The
fingerprint is the key's AES-GCM tag of nothing under a nonce no value is ever sealed under, a key
check value: it names the key without revealing anything of it, and the runtime computes it from
the key itself, so it checks every key it reads against it, even one it can never export. Whether a person's processing is restricted, and since when, lives apart, in
`bounda_persons`, since a person without a key is restricted all the same, and so does, with a
retention, when they were last active and last forgotten. A key is created when the first event
with a personal field of that person is stored, by the transaction that stores it, and deleted by
`forget`. Encryption is AES-256-GCM through WebCrypto, with a nonce per value, on Node and in
`workerd` alike; what the store holds for a personal field is an envelope with the ciphertext, the
person's id and the key's fingerprint, which the [global stream](/guides/reading-the-stream/)
shows as it is; a value sealed under a key the person no longer has, because they were forgotten
and registered again, reads as `null` next to what their new key opens. What is read is opened by
that shape, whatever the schema marks, so an event or a delayed command whose handler or caller
writes an envelope itself, in any field, is refused with a `ValidationError`: it could only read
back as `null`, or not at all.

### A master key

A key kept next to the data opens it for whoever reads the database: a dump, a backup, a replica,
a support session. So the runtime wraps every person's key before the store keeps it, under a
master key that never enters the database: envelope encryption, what a cloud KMS does. The
fingerprint stays that of the key, whatever it is wrapped under, so `forget` is still one
transaction and nothing else changes; a copy of the database without the master key opens
nothing.

```ts
import { defineConfig, masterKey } from "@bounda-dev/core/config";
import { sqlite } from "@bounda-dev/sqlite";

export default defineConfig({
  storage: sqlite({ path: "./data/app.db" }),
  runtime: {
    personalData: { keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }) },
  },
});
```

`from` names the environment variable, never the key, and the app reads it from the host's
environment when it starts: `process.env` in Node, after `boot()` has loaded `.env`, and the
Worker's secrets in a Durable Object. It holds 32 random bytes in base64:

```sh
openssl rand -base64 32
```

A variable that is missing, or holds anything else, fails the start with a `ConfigurationError`
that names the variable, never its value. The keys are wrapped with AES-KW; each master key's id is
derived from it, so a wrong master key is told apart from the right one: reading a key it did not
wrap fails with a `ConfigurationError` saying under which id that key is.

A project from `create-bounda` comes with one: a key generated for it in `.env` on Node, or in
`.dev.vars` on Cloudflare, both left out of Git, and the configuration above. In production, set
the variable the way the host keeps secrets. On Cloudflare that is a secret of the Worker:

```sh
npx wrangler secret put BOUNDA_MASTER_KEY
```

Keep the master key as you keep the database's backups, for as long as they are kept: lost, it
takes every person's data with it, as if each had been forgotten. `bounda rebuild` reads it from
`.env` like `boot()`; `rebuildReadModel` takes the environment as `env`.

Under a master key, a person's key exists in the app only as a WebCrypto key that can never be
exported. WebCrypto generates it, wraps it under the master key and unwraps it straight into a key
it seals and opens with, so its raw bytes never reach JavaScript memory, where nothing could erase
them: no string, no buffer, on Node, in `workerd` or in a test app given the master key. The bytes read from the master key's variable
are zeroed once imported; the variable itself is the one copy the host keeps.

Unwrapped keys are kept in memory, by fingerprint, up to ten thousand per app and for five
minutes from the moment each was unwrapped, so a command does not pay for unwrapping on every
read, and the key of someone no longer active does not stay usable in the process: keys past their
time go at the next read of any key, and a timer drops them when no key is read, without keeping
a Node process alive. A Durable Object arms no such timer, which would keep it from sleeping: there
they go at the next read, or with the object when the platform evicts it. A forgotten person's key
goes once the forget commits, and the keys the rotation unwraps are not kept. The person's row is
still read first every time: a person forgotten on another instance is forgotten here at once.

Without `keyWrapper` the keys are kept as they are, next to the data, and the app logs a warning
when it starts if the registry marks any field `personal`; an app from `createTestApp` warns
nothing. Then the key's text is what the store holds, read back as a string: the runtime exports a
new key once, to store it, imports what it reads at once, and zeroes the bytes either way. Setting one later wraps the keys kept so far in the background, as a rotation does.

### Rotating the master key

Generate a new key, give it the variable the configuration reads, and move the old one to
`previous`:

```ts
keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY", previous: ["BOUNDA_MASTER_KEY_OLD"] }),
```

A key wrapped under a previous master key still opens; the worker rewraps them under the current
one in batches, on every pass, as the retention sweep runs. A key that fails to rewrap waits on its
row, as a person the retention could not forget does, while the others go on. Once none is left
the worker marks the rotation complete for this set of master keys, in `bounda_checkpoints`, and
logs it once:

```
no personal key is wrapped under a previous key any more; remove them
```

Then remove the old variable and `previous`. Rewrapping changes no event and no fingerprint, so it
runs while the app serves. A Durable Object wakes for it as for a deadline. While the mark stands,
`nextDueAt()` never reads the key table, and the passes read it once a minute across every
instance, dropping the mark if they find a key to rewrap: an instance still on the old
configuration, in a rolling deploy, may wrap a new key under the old master key, and the next
pass after that minute finds it. Changing the master keys, `previous` included, reads the table
again; the old configuration's mark stays while instances on it may still run, and goes once none
has renewed it for ten minutes.

Destroying the old master key once the backups taken before the rotation have expired is what
makes those backups unreadable as a whole.

### A KMS or a vault

`masterKey` keeps the master key in the app's environment. A KMS, Vault's transit engine or an HSM
keeps it out of the app altogether: give `keyWrapper` an implementation of `KeyWrapper` through
`defineKeyWrapper`, which receives the host's environment when the app starts. With AWS KMS:

```ts
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { defineConfig, defineKeyWrapper } from "@bounda-dev/core/config";
import { sqlite } from "@bounda-dev/sqlite";

const kms = defineKeyWrapper(({ env }) => {
  const keyId = env.BOUNDA_KMS_KEY_ID;
  if (keyId === undefined) throw new Error("Set BOUNDA_KMS_KEY_ID to the KMS key's ARN");
  const client = new KMSClient({});
  return {
    kid: keyId,
    wrap: async (key) => {
      const { CiphertextBlob } = await client.send(
        new EncryptCommand({ KeyId: keyId, Plaintext: key }),
      );
      if (CiphertextBlob === undefined) throw new Error("KMS returned no ciphertext");
      return CiphertextBlob;
    },
    unwrap: async ({ kid, wrapped }) => {
      const { Plaintext } = await client.send(
        new DecryptCommand({ KeyId: kid, CiphertextBlob: wrapped }),
      );
      if (Plaintext === undefined) throw new Error("KMS returned no plaintext");
      return Plaintext;
    },
  };
});

export default defineConfig({
  storage: sqlite({ path: "./data/app.db" }),
  runtime: { personalData: { keyWrapper: kms } },
});
```

`kid` is stored next to every key the wrapper wraps; `unwrap` receives it back, with what `wrap`
returned. A KMS needs the key's raw bytes, so they exist while `wrap` and `unwrap` run, and only
then: the runtime zeroes the array it gives `wrap` once it settles, and imports what `unwrap`
resolves as a key that can never be exported and zeroes that array at once. So resolve a
`Uint8Array` of your own, as the SDK hands it, and keep no copy of either. The runtime checks the
key `unwrap` answers against its fingerprint, so a wrapper that answers with another key fails
loudly instead of sealing data under it. Creating a key takes one call to `wrap` and none to
`unwrap`. KMS rotates a key's material itself and keeps decrypting under the old one with the
same ARN, so `kid` does not change; moving to another KMS key is a rotation as above, with the old
ARN in `previous`. Each instance asks KMS once per person it creates, and once per person it reads
in every five minutes they are active, thanks to the cache.

A wrapper that fails, because KMS is unreachable, fails the command that needed the key, which
the caller or the reaction's retry sees; the person's data is not touched.

## Backups

Restoring a copy of the database taken before someone was forgotten brings their key back, and
with it their data: the only record that they were forgotten was in the database the copy
replaced. The ICO's guidance for backups is to put them beyond use while they exist and, when one
is restored, to apply the erasures again. A forget ledger is how Bounda does the second part.

### The forget ledger

The ledger is a record of every forgetting kept outside the database: for each `PersonalDataForgotten`,
the person's id, the event's id, its time, its reason, and the fingerprints of the keys it
destroys, and nothing else. It is a suppression list, the one thing about a forgotten person that
has to outlive their data, so it holds no field of theirs; a fingerprint is a check value of a key,
which opens nothing and names nothing once the key is gone. Give it a store a restore of the
database does not touch:

```ts
import { defineConfig, masterKey } from "@bounda-dev/core/config";
import { sqlite } from "@bounda-dev/sqlite";

export default defineConfig({
  storage: sqlite({ path: "./data/app.db" }),
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
      forgetLedger: { store: sqlite({ path: "./ledger/forget-ledger.db" }) },
    },
  },
});
```

Its `store` takes any adapter pointed at another database, where it creates one table,
`bounda_forget_ledger`, with the adapter's `tablePrefix`, the first time it is used: a SQLite file
on another disk or volume for an app on one machine, `postgresql({ url })` on another server, or a
schema of the same server backed up apart. A plain file of the app's own making would be the same
thing with less: the SQLite file already is one, written atomically. An adapter that points at the
storage's own database, which a restore would roll back with it, fails the start with a
`ConfigurationError`. The table keeps each tenant's entries apart, so tenants can share one
ledger.

On Cloudflare a restore of a Durable Object's storage goes back to a point in time, the ledger
with it if it lived there, so the ledger is a KV namespace:

```ts
import { cloudflare, kvForgetLedger } from "@bounda-dev/cloudflare";
import { defineConfig, masterKey } from "@bounda-dev/core/config";

export default defineConfig({
  storage: cloudflare(),
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
      forgetLedger: { store: kvForgetLedger({ binding: "FORGET_LEDGER" }) },
    },
  },
});
```

```jsonc
// wrangler.jsonc
"kv_namespaces": [{ "binding": "FORGET_LEDGER", "id": "<the namespace's id>" }]
```

Every object keeps its entries under its own name, so an object reached through an id without a
name fails to start; `createWorker` names each by its tenant. KV may take up to a minute to list a key it
just wrote, so an object that starts reads the ledger once more a minute later, and wakes for it.
Anything else is a ledger of your own through `defineForgetLedger`, which receives the host's
environment, the tenant and `keepForMs` when the app starts: it keeps every field of an entry, the
reason and the fingerprints included, which the reconciliation decides by; its `read` returns
entries in the order of their time, then of their event's id, and `byForgetLedgerOrder` from
`@bounda-dev/core/adapter` sorts them so; its optional `prune` removes the entries older than a
time; `forgetLedgerContract` from `@bounda-dev/core/adapter/testing` is the test it has to pass.

### What the runtime does with it

Every forgetting writes its intention to the ledger first, and commits after: `forget`, a policy
or process, the retention, `forgetAgain`. The intention is the entry the forgetting will be: its
event's id and time are set before the transaction, and the transaction appends the event with
them, so the ledger and the database name one forgetting by one id. A policy's or process's
`forget` writes it just before its run's transaction opens, once the run has decided.

What happens to an intention whose commit does not happen, because the process stopped in between
or the database refused the transaction, is the same in every case: the next reconciliation
commits it, since forgetting is what was asked. A `forget` that rejects after its intention was
written still forgets the person then; calling it again forgets them at once, and is never an
error. The retention is the one exception, as it decides on the person's activity: a forgetting
the retention made is committed again only while the retention would still forget the person,
read on the database as it is then, so a person who came back, or whose processing was
restricted, keeps their data.

An intention names the key the person held when it was written, and a reconciliation commits it
only while the person still holds that key: a key they hold that it does not name was given to
them after, as when they come back and register again, and is kept. That also settles the order
between several intentions of one person, which never changes the result: each commits only while
the key it names is there, so the first to commit destroys it and the others find it gone. A
reconciliation leaves an entry younger than a minute, `FORGET_LEDGER_GRACE_MS` from
`@bounda-dev/core`, to the next one, due once it is old enough: it may be the intention of a
forgetting still committing, which then commits with its own actor.

The event store is also the ledger's outbox: a subscriber of the dispatcher, `forget-ledger`,
copies every `PersonalDataForgotten` to the ledger again in batches, with a policy's guarantee,
and the ledger keeps one entry per event however often it receives it. So a forgetting whose
intention the ledger refused, or did not take within its `timeout`, which an app that is not
strict logs as a warning and commits all the same, still reaches it: a batch the ledger refuses is
delivered again, and the subscriber's lag in `getLag` and `bounda.dispatcher.lag` shows how far
behind it is. While an intention the ledger did not take in time is still pending, the next
forgettings do not wait for it, and leave their copy to the subscriber. Configuring a ledger on an
app that already forgot people copies those forgettings first.

When the app starts, before it serves anything, it reads the ledger past a cursor the database
keeps, the time of the last entry it applied, and commits again, under its own id, time and
reason, each forgetting the database does not hold whose person still holds a key it names. After
a normal start that read returns next to nothing. After a restore the cursor went back with the
copy, and the read returns exactly the forgettings made since the copy was taken, the intentions
whose commit never happened included; the read models that show those persons hear of it before
the start resolves, and the app logs how many it committed again:

```
committed again forgettings the database did not hold
```

An entry whose forgetting the database holds is skipped even when the person holds a key, since
that key was given to them after they were forgotten. The check and the forgetting are one
transaction, so instances starting together forget a person once. A Durable Object does it on
every cold start; restoring its storage restarts it.

While the app runs, it reads the ledger again every `reconcileEvery`, five minutes unless you set
it, so a database restored under a running app forgets again within that time. One instance
takes each round, whichever finds it due first, and the time of the last round is kept in the
database, so a restore takes it back too and cannot hold the next round off. The
round runs on the worker's passes, in every instance whose role runs the worker; a Durable Object
runs it on the passes it wakes for, never waking for it alone, since restoring its storage
restarts it anyway. Restarting the app after a restore reconciles at once.

Each call to the ledger is given up after its `timeout`, ten seconds unless you set it, with
[`FORGET_LEDGER_TIMEOUT`](/reference/errors/#codes); the call may still land after it. A ledger
that cannot be read when the app starts does not stop it: the app logs an error, starts, and its
worker tries again after 30 seconds, then twice as long after each failure, up to an hour.
The wait is kept in `bounda_checkpoints`, beside the cursor, so every instance waits for the
longest and a restart backs off from where it was, though a start always tries once; the first
reconciliation that succeeds clears it.
A reconciliation that takes longer than the `timeout` as a whole, each call within it, is left to
finish in the background, with an error logged, and the app starts.
Until then `getLag()` says `forgetLedger: { reconciled: false }`, and a person the restore
brought back can be read; alert on it. An app without a ledger reports `forgetLedger: null`.

To never forget anyone the ledger has not recorded, nor serve before the ledger was read, make it
strict:

```ts
forgetLedger: { store: sqlite({ path: "./ledger/forget-ledger.db" }), strict: true },
```

A strict app forgets nobody whose intention the ledger did not take: `forget`, `forgetAgain` and
a policy's `forget` fail with [`FORGET_LEDGER_UNAVAILABLE`](/reference/errors/#codes), the
ledger's error as its `cause`, and nothing is forgotten, so trying again is safe; a policy's run
fails and is retried as any other, and the retention holds the person and tries again later. It
waits at start for the reconciliation however long it takes, each call within the `timeout`, and a
ledger it cannot read fails the start with
[`FORGET_LEDGER_UNRECONCILED`](/reference/errors/#codes), the ledger's error as its `cause`;
starting again tries again. The CLI's commands that start the app need the ledger then;
`bounda forgotten` does not, since it reads the event store alone. Availability now depends on the
ledger's: give it a store at least as available as the database.

A strict app loses no forgetting to a restore: each is in the ledger before it commits. One that is
not strict loses only a forgetting whose intention the ledger did not take, while it was down or
slow, and that the subscriber had not copied yet when the database was lost. Keep the
`forget-ledger` subscriber's lag near zero, as for any other.

### Keeping the ledger short

The ledger only matters for backups you can still restore. With `keepFor`, an entry older than
that is removed: set it a little longer than your oldest restorable backup.

```ts
forgetLedger: { store: sqlite({ path: "./ledger/forget-ledger.db" }), keepFor: "35d" },
```

The instance that takes a periodic round prunes after it, through the ledger's `prune`, and a
forgetting older than `keepFor` is not appended at all. KV expires each key on its own instead,
`keepFor` after its forgetting, since it cannot list its oldest keys first. A backup older than
`keepFor` brings back whom the removed entries named, so when you keep backups longer, raise it
first. Without `keepFor` entries are kept for good: ids, times and fingerprints only, but still the
ids of people who asked to be forgotten.

A KV key gets its expiration when it is written, so the keys written before `keepFor` was set, or
while it was longer, keep theirs. Give them the one `keepFor` sets now, from the project's root,
with the binding and the `keepFor` of the configuration:

```bash
bounda forget-ledger expire --binding FORGET_LEDGER --keep-for 35d
```

It goes through the project's wrangler, logged in to the account, to the deployed namespace,
`--local` to the state of `wrangler dev`, with `--env` and `--wrangler-config` as wrangler takes
them; it writes every object's keys again with their expiration and removes those already past
it. `expireKvForgetLedger({ namespace, keepForMs })` from `@bounda-dev/cloudflare` does the same
from a Worker, within the KV operations one invocation may make.

### Without a ledger

The CLI does the same by hand. Before restoring, while the old database can still be read, or
regularly, as part of the backups, save who was forgotten since the copy you will restore was
taken:

```bash
bounda forgotten --since 2026-11-01T03:00:00Z > forgotten.jsonl
```

Then, once the copy is back:

```bash
bounda forget --from forgotten.jsonl
```

`bounda forgotten` prints one line of JSON per forgetting, the entry a ledger would hold, reading
the event store without starting the app; `bounda forget` commits again each forgetting listed,
under its own id, time and reason, as a reconciliation would: unless the database holds it, and
only while the person holds a key it names. With a ledger configured, it records each in the
ledger first. A line may also be a bare person's id, for a list kept some other way, which is
forgotten, as a request, whenever the person holds a key: list only those forgotten after the copy
was taken. `--actor <id>` names who does it on each `PersonalDataForgotten` it appends.
`app.forgetAgain(entries, { actor })` is the same in code.

Without either, a restored backup brings back the data of everyone forgotten after it was taken,
until they are forgotten again.

### Old backups

The ledger handles a backup once it is restored. Rotating the [master key](#rotating-the-master-key)
handles the others: destroying the old key once every backup it covers has expired leaves those
backups unreadable as a whole, the forgotten persons with everyone else.

## In tests

`createTestApp` forgets like any app, and `expectForgotten` checks that nothing of the person is
left readable:

```ts
import { createTestApp, expectForgotten } from "@bounda-dev/core/testing";

const { app } = await createTestApp({ registry });
await app.commands.registerCustomer({ customerId: "c-1", email: "ana@example.com", plan: "pro" });
await app.forget("c-1");
await app.runUntilIdle();
expect(await app.queries.getCustomer({ customerId: "c-1" })).toEqual({ customerId: "c-1" });
await expectForgotten(app, "c-1");
```

It looks for every value the person had: each value of a field marked `personal()` that the test
app sealed under a key they no longer hold, in an event, a process's state, a command it stored or
a dead letter, a cancelled command's included, and each value a read model kept in a field marked
`.personal()` for them before they were forgotten. It searches every place the runtime keeps
something, read as stored, never through the APIs that open fields: every table of the storage
and of each read model's adapter, unmarked columns and JSON documents included, so a projection
that copied the email into a column it did not mark is found; the forget ledger; and every entry
the app logged through the test app's `logger`. A test app logs the text of errors so a failing
test says what failed, which an app outside a test does not do by default (see
[`runtime.telemetry.errorText`](/reference/observability/#error-text)): that text, in logs and
spans, is searched only when the test's `config` sets `errorText` itself. A person given a key again after the forgetting
keeps what they gave since: only what was sealed under the keys they lost is looked for.

When it finds a value, it rejects with `NotForgottenError`, whose message lists each place and
says what to do about each kind:

```
Person "c-1" was not forgotten everywhere: 1 place still holds a value of theirs in the clear.
  - "ana@example.com" in bounda_rm_customer_directory, customer_id=c-1, greeting
What to do:
  - A read model kept the value: project PersonalDataForgotten in it and delete the row or clear the field, and mark the field .personal() so its export and the access log see it.
```

`error.found` holds the same as data: `{ value, store, row, field }` for each. It is a plain
`async` function, so it works under any test runner.

A value is matched whatever its case, inside any longer text: an error message, a log line, a
JSON column. One shorter than `MIN_SUBSTRING_LENGTH` characters is matched only as a whole word,
since `Ana` turns up inside `Banana`; key material and ciphertext are compared whole, never
searched inside, since a short value turns up in random text by chance. Numbers count as their
digits, booleans and `null` not at all, and a value equal to the person's id is never looked for,
since ids stay by design. Give test data values that appear nowhere else, as `ana@example.com`
does.

The options say what else to look for and where:

```ts
import { expectForgotten, recordTelemetry } from "@bounda-dev/core/testing";

const telemetry = recordTelemetry();
try {
  // ...
  await expectForgotten(app, "c-1", {
    values: ["Ana G.", "+34 600 123 456"],
    telemetry,
    places: { mailer: mailer.sent },
  });
} finally {
  telemetry.stop();
}
```

- `values`: what a handler or a projection derived from the person's fields, a lowercased
  email or a formatted phone number, which no seal holds.
- `before`: the person's [export](#exporting-a-persons-data), taken before they were forgotten;
  every value it opened is looked for.
- `telemetry`: what `recordTelemetry()` recorded, so every span the runtime started, its
  attributes, status, exceptions and events, is searched too. It registers a global
  OpenTelemetry tracer provider until `stop()`, and throws when one is registered already, since
  OpenTelemetry keeps the first.
- `places`: anything else, under the name the report gives it: what a test double of a port was
  sent, so a test proves the [policy that tells the outside world](#telling-the-outside-world)
  erased it there too.

It refuses to pass for want of something to look for: a person who still holds their key, or one
with no value to look for and no `values`, rejects with an `Error` saying so.

`expectForgotten` also takes an adapter instead of the app, and then searches that adapter's
tables for `values` and `before` alone: for an app built with `createApp` or `boot()`, or a
Durable Object's storage, read from inside the object with `durableObjectAdapter` from
`@bounda-dev/cloudflare` (see [Testing on Cloudflare](/adapters/cloudflare/#testing)). It reads
the whole database, so point it only at a test's, and call it before `app.stop()`: an
in-memory database is gone once the app stops. It works on every adapter: the in-memory one,
SQLite, the Durable Object and PostgreSQL alike, each through its `inspect()`.

`app.runUntilIdle()` never moves a test's clock to a retention deadline, or every person the test
created would be forgotten; a test reaches it by moving the clock itself:

```ts
const { app, clock } = await createTestApp({
  registry,
  config: { runtime: { personalData: { retention: "30d" } } },
});
await app.commands.registerCustomer({ customerId: "c-1", email: "ana@example.com", plan: "pro" });
await app.runUntilIdle();
clock.advance(31 * 86_400_000);
await app.runUntilIdle();
expect((await app.exportPersonalData("c-1")).events[0]?.data).toEqual({ email: null });
```
