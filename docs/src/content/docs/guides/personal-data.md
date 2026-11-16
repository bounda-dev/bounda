---
title: Personal data
description: Mark the fields of an event, a process state or a read model that hold personal data, and those that hold none, say whose they are, print the record of processing activities, sort them in categories with their legal basis and retention, seal what was written before a field was marked, forget a person, export their data or correct it with one call, tell the recipients their data went to, record who opened whose data, forget them after a retention or when a purpose ends, wrap their keys under a master key kept out of the database, handle forgetting in every read model that showed them, and check in a test that nothing of a forgotten person, nor a value corrected, is left readable.
sidebar:
  order: 11
---

Events are never deleted, so personal data in one is forgotten by making it unreadable: each
person has a key for each [category](#categories) of their data, their fields are stored encrypted
with the key of the field's category, and `forget` throws the keys away.
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

export const payload = ({ z, personal, person, notPersonal }: Event.PayloadArgs) =>
  z.object({
    customerId: person(z.string()),
    lines: notPersonal(z.array(z.object({ sku: z.string(), quantity: z.int().positive() }))),
    deliveryNote: personal(z.string()).optional(),
  });
```

An event names at most one person.

### Fields that hold no personal data

A field nobody marks may be personal data nobody looked at, so a field that holds none says so
with `notPersonal`, next to `personal` and `person` in the same arguments:

```ts
export const payload = ({ z, person, personal, notPersonal }: Event.PayloadArgs) =>
  z.object({
    customerId: person(z.string()),
    sku: notPersonal(z.string()),
    quantity: z.int().positive(),
    deliveryNote: personal(z.string()).optional(),
  });
```

`notPersonal` changes nothing at rest: the field is stored as it comes, and validates and reads as
its schema says. It records a decision, which the [record of processing
activities](#the-record-of-processing-activities) lists for whoever reviews it. It works where
`personal` does, on a top-level field of an event's or a command's payload or of a process's state,
a whole object or array included, and a read-model column takes `.notPersonal()`. A field holds one
mark: `personal`, `person` or `notPersonal` on a schema that already carries another throws
`ConfigurationError`, and `.notPersonal()` comes only on a column `.personal()` and `.person()` left
unmarked.

Every field that can hold text needs one of the three: a string that is not one of a set of
literals, a template literal, `unknown` or `any`, or an object, array, record, map, set, tuple or
union that can contain one, keys of a record included. A number, a boolean, a date, a literal or an
enum cannot carry text, so they need none; `instant()` and `deadline()` in a process's state hold a
moment and need none either. In a read model every `f.string()` column needs one, whatever its
projections write, since the column holds any text the database is given, and an `f.json<T>()`
column once `T` can hold text. A query's payload needs none: a query is never stored.

The check is the compiler's: `.bounda/types.ts` fails to compile at `<Aggregate>Classification`
or `<ReadModel>Classification` while one is missing, with a message naming each field, such as
`order.OrderPlaced: field note can hold text; mark it personal(), person() or notPersonal()`. It
fails the same way on text no mark can reach: a payload or a state that is not an object, or an
object that keeps keys it does not declare (`z.looseObject`, `.catchall()`), since a mark sits on
a declared top-level field. The app refuses to start on the same with `ConfigurationError`, for a
project that skipped the type check; that check reads the schemas themselves, so it cannot see the
output of a `.transform()` or the `T` of a JSON column, which only the compiler reads.

The rule is there so personal data is never stored because nobody looked: a field added to a
payload is decided when it is written, personal or not, and the [record of processing
activities](#the-record-of-processing-activities) lists every decision.

## Categories

Not all of a person's data goes at the same time. A profile is kept while they are a customer; an
invoice, for the years the law asks, even if they ask to be forgotten; a newsletter address, until
they withdraw their consent. Each kind is a category, declared in `app/personal-data.ts` with its
legal basis, as article 6 of the GDPR names it, and its retention:

```ts
// app/personal-data.ts
import type { PersonalData } from "./+types/personal-data";

export const categories = {
  profile: { basis: "contract", retention: "30d" },
  marketing: { basis: "consent", retention: "730d" },
  invoices: { basis: "legal-obligation", retention: "6y" },
} satisfies PersonalData.Categories;
```

The basis is one of `consent`, `contract`, `legal-obligation`, `vital-interests`, `public-task` and
`legitimate-interests`. The retention is how long the category is kept after the person's last
activity: a duration as the configuration writes them, `"30d"`, or whole calendar months or
years, `"18mo"`, `"6y"`, which a legal period is given in. A calendar period ends on the same day of
the month and at the same time, leap years and months of unequal length counted as they fall; a day
the end's month lacks, as the 29th of February six years on, ends at the very end of that month's
last day, so a period is never cut short. `runtime.personalData.retention` takes the same. A field takes a category with `personal`'s second argument, and a read
model's field with `.personal`'s:

```ts
export const payload = ({ z, personal, person }: Event.PayloadArgs) =>
  z.object({
    customerId: person(z.string()),
    total: z.number(),
    billingAddress: personal(z.string(), { category: "invoices" }),
    deliveryNote: personal(z.string(), { category: "profile" }).optional(),
  });
```

The generator registers the names, so a category the file does not declare, in `personal`,
`.personal` or `forget`, does not compile, and `.bounda/types.ts` fails to compile while the file
declares a category `default` or one without a basis Bounda knows or a retention; the app refuses
to start on the same, for a project that skipped the type check. A field marked without a
category is in the default category, `default`, whose retention is
[`runtime.personalData.retention`](#inactivity) and which declares no basis: an app without
`app/personal-data.ts` has that category alone, and behaves as if categories did not exist.

Each person has a key per category, created when a field of that category is first sealed for
them, so an event or a command that holds fields of several categories seals each under its own
key, and each category is forgotten on its own:

- `forget(person)` forgets every category, as below.
- `forget(person, { categories: ["marketing"] })` forgets those alone, as when a consent is
  withdrawn: their fields read as `null`, the rest stays readable, and the person is not forgotten
  as a whole.
- Each category is forgotten after its own [retention](#each-category-for-its-own-time).

A category whose basis is `legal-obligation` outlives a `forget` while its retention, counted from
the person's last activity, has not run out: the law that requires the data outweighs the request
to erase it (article 17(3)(b)). Its key is kept, [restricted](#restricting-processing), and no
longer in force: what it sealed still opens for the export, for a query that reads on
`legal-obligation` and for work that names that basis, while a command, a policy or a process that
names none reads it as `null`, as if forgotten; nothing new is sealed under it,
no snapshot holds its data, a [remembered answer](#remembered-answers) sealed under it is erased,
and the scheduled commands and dead letters that held it go with the rest. The key's last activity is fixed at the forgetting, so a person who
comes back extends nothing kept from before: what they write afterwards gets a new key in force,
and the kept one goes on its own once its retention has passed, with a `PersonalDataForgotten`
that names the category in `expired`. Whether a key is kept that way, and since when, is recorded
on its row. A category whose retention had already run out at the forgetting is forgotten with the
rest.

### Changing a category

A category's retention can change at any time: the sweep reads it as it runs, so a longer or a
shorter one applies at once to every person, what a forgetting kept included. So does a basis, and
a category removed from the file: a key a forgetting kept under a legal obligation is destroyed by
the next pass of the worker once its category is no longer a `legal-obligation` one, with a
`PersonalDataForgotten` that names it in `expired`, since nothing allows keeping it any more.

A field moved to another category, or out of a category into the default one or back, is sealed
anew under the person's key of its new category by the [backfill](#marking-a-field-later), in every
event, process state, scheduled command and dead letter that holds it: the marks changed, so the
worker walks the stream again, opens each value sealed under a category its field is no longer in
and seals it under the right one, as the forgettings since it was written say, a category kept or
forgotten included. From then on forgetting the old category no longer reaches the value, and
forgetting the new one does. A [remembered answer](#remembered-answers) sealed under the earlier
marks, which may quote it, is erased, and a snapshot of its stream is dropped and folded again. A
value no key opens any more, its
person forgotten in its old category, stays as it is: it was forgotten already. Going back to
earlier marks walks the stream again too.

## In a command's payload

A command is stored too when it waits: dispatched with `delay`, retried by the scheduler after a
failure, or dead-lettered once it gives up. A command that carries personal data marks its payload
the same way, with `personal` and `person` from its own `PayloadArgs`:

```ts
// app/domain/customer/commands/remind-customer.ts
import type { Command } from "./+types/remind-customer";

export const payload = ({ z, personal, notPersonal }: Command.PayloadArgs) =>
  z.object({ customerId: notPersonal(z.string()), email: personal(z.email()) });
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
and a step that fails has its error text encrypted with the keys of the person its event names,
or else of the one the state names, which covers a deadline. When the event names one person and
the state another, the [dead letter](/guides/dead-letters/#what-a-letter-holds) names both, the
state's as `statePerson`, and its text is encrypted under the keys of each, one inside the other:
the step read the state, and a handler's error may quote it. Forgetting either leaves the text
unreadable, and the export, a restriction and a redaction of either reach the letter. A lifecycle
event written before its state marked its fields is sealed in place by the
[backfill](#marking-a-field-later), and so is a letter filed before: its text is sealed under the
person the state of its instance named when the step failed too.

## What the types say

Whoever writes the event, the command handler through `events.customerRegistered({ email })`,
passes what the schema takes: a `string`. Whoever reads it, `begin`, `evolve`, a policy, a
projection, a process, sees `string | null`: the value, or `null` once the person is forgotten, or
once the field is [redacted](#correcting-a-persons-data). So does a process handler that
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
commands, dead letters and remembered answers, and from then on reads what comes after once a
minute: an instance still running the old marks, as in a rolling deploy, writes in the clear for a
while, and what it writes is sealed that much later, the stores included, which the walk goes
through again on each pass for as long as such an instance renews its lease, and once more after.
One instance walks at a time, under a lease kept in
`bounda_checkpoints`; a batch that fails, because the [key wrapper](#where-the-keys-live) does not
answer, say, holds the walk for every instance, 30 seconds and twice as long after each failure in
a row, up to an hour, and the worker logs it.

A person forgotten before the marks were added has no key to seal with, and creating one would make
what their forgetting should have covered readable again. What an event held of them before their
last forgetting is sealed under a key no store keeps, and reads as `null`, as if it had been marked
then; what came after, once they were registered again, is sealed under the key they hold now. A
scheduled command gets the same by when it was scheduled, which its entry keeps, and a dead letter by
when it failed: one written before a forgetting of its person is sealed under a key no store keeps,
one written after under their key, and one that nothing says the time of, a command scheduled by a
version that did not record it, is taken as written before. The text of an error never gets a new
key, as when a handler fails. The worker logs `personal data of
persons forgotten before it was marked is sealed for good; rebuild the read models that project it`
with the event types: a read model that showed those fields keeps what it projected before the
forgetting reached them, and a [rebuild](/guides/deployment/#rebuilding-a-read-model) replays the events with
them forgotten. No other read model needs one: sealing changes how an event is stored, never what it
reads as. A snapshot folded from fields in the clear is dropped with the batch that seals its stream,
since it names nobody a `forget` would remove it for, and the next command folds the stream again.

What it cannot seal stays as it was, and the worker says so: a value in the clear in an event whose
`person` field is empty, `personal data written before its marks names no person and stays in the
clear`, with the event types, and a scheduled or dead-lettered command whose `person` field is
empty, `commands stored before their marks name no person and stay in the clear`. An event whose
`person` field changed since it was sealed keeps the person it was sealed for. A person whose
processing is restricted has their data sealed all the same: sealing protects it, and processes
nothing.

An event of a type that marks fields, stored in an older shape that its
[upcasters](/guides/changing-events/) bring up to date, is rewritten in its current one: what it
holds sealed is opened, `null` where no key opens it any more, as the upcasters read it, the
upcasters run, and the fields its schema marks today are sealed under the person it was sealed for,
or else the one its current shape names, before it is written in place with the current schema
version. A field an upcaster renamed or computed is sealed under its name of today, and one it
dropped is gone from the store. While an instance on other marks renews its lease, as one still
running the previous code in a rolling deploy, which may not know the current version, events are
left in their stored shape and sealed as their marks say, and the walk goes back to the first it
left once that instance has stopped; `caughtUp` waits for it. From then on an instance of the
previous code refuses those events, as it refuses the events a newer deploy writes: roll forward.

An answer remembered under an [`idempotencyKey`](/guides/idempotent-commands/) is sealed under the
marks of its day, which said whom it quotes and in which categories: one sealed under other marks
is [erased](#remembered-answers) by the walk, its key kept taken until it expires.

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
`metadata.actor`, and so on `ProcessingRestricted` and `ProcessingRestrictionLifted`. In one transaction it deletes the person's keys, but those a
[legal obligation keeps](#categories), cancels the scheduled commands that hold their data, removes
the dead letters of those that gave up, and appends `PersonalDataForgotten` to the stream
`bounda:<personId>`: the runtime's own aggregate, `bounda`, has one stream per person it forgot.
Its payload is `{ personId, reason, whole, categories, retained, expired, fingerprints,
cancelledCommands, removedDeadLetters }`:

- `reason` is `"requested"` for `forget` and `"retention"` when the [retention](#retention) forgot
  them. A forgetting a [forget ledger](#backups) commits again keeps its id, its time and its
  reason.
- `whole` is `true` when the person was forgotten as a whole, and `false` for
  `forget(person, { categories })` or a category's retention, and for a forgetting committed again
  from the [ledger](#backups) that kept a key given to the person after it: that key's category is
  then not among `categories` either.
- `categories` are the categories forgotten, every one but those `retained` when `whole`;
  `retained`, those a legal obligation kept; `expired`, those kept at an earlier forgetting whose
  retention ended now.
- `fingerprints` names the keys it covered, destroyed or retained, by their check value, which
  opens nothing; none for a person who held none.
- The rest are the ids and types of what went, the only record of commands that never became
  events.

`forget(person, { categories })` forgets those categories alone: their keys go, and so do the
scheduled commands, dead letters and snapshots that hold data sealed under them, while the
[remembered answers](#remembered-answers) sealed under them are erased; the rest of the person's
data, and what holds it, stays. Naming a category the app does not
have, or none, is refused with `ValidationError`. It resolves like a command, with the event's
position, so `catchUpReadModels({ through })` waits for the read models that handle it, and the Durable Object's `forget` and the one in React
Router's `bounda` context wait for them themselves unless `consistency` is `"eventual"`. A person
without a key is forgotten all the same, since a read model may hold what their events carried in
the clear, and forgetting twice appends twice. An empty id is refused with `ValidationError`.

From then on every personal field of theirs reads as `null`, in every event, however old, but
those of a category kept under a legal obligation. A person registered again gets fresh keys;
their old events stay unreadable. A command running
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
transaction removes every snapshot whose state carried a field of theirs under a key that goes or is
kept; each one names the people it holds and the key it read each one under, and none is written
for a person who no longer holds that key in force. The next command on such an
aggregate folds it from its first event, with the fields forgotten, and the snapshot after it
holds them as `null`.

The message of an error a handler throws may quote a personal field it read, of any category, so a
[dead letter](/guides/dead-letters/#what-a-letter-holds) keeps the message and the stack encrypted
under every key the person its work names holds, one inside the other, and forgetting any category
of theirs leaves the letter in place with them reading as `null`. The keys are those the work read their data under: a person forgotten while the handler
was failing, and given a fresh key before it gave up, has the text encrypted under a key nobody
keeps, so it reads as `null` too instead of opening under the fresh key; the stream's `ScheduledCommandFailed` and `ProcessFailed` name the error's class and code
and never its text, and so does the last error the inbox and the scheduler keep of a claim.

The runtime's own log lines and spans carry no error's text: an error is logged and traced by its
class, its code and the ids of what failed, and the line that files a dead letter names the letter,
whose text `app.deadLetters` opens for as long as the person is not forgotten. Only
[`runtime.telemetry.errorText: "include"`](/reference/observability/#error-text), or
`BOUNDA_ERROR_TEXT=include`, puts the message and the stack there, in the clear, out of `forget`'s
reach: keep it to development. A React Router app logs what its requests throw by the same rule
once `app/entry.server.tsx` exports Bounda's `handleError`
([logging errors](/guides/react-router/#logging-errors)); without it, React Router logs every
message and stack.

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

### Remembered answers

A command dispatched with an [`idempotencyKey`](/guides/idempotent-commands/) remembers what it
answered, so a retry answers the same. That answer is the personal data of the person the command
touches, the one its payload names with `person` or whose aggregate is the person: a rejection's
message may quote anything the handler saw, the state and the payload, of any category. So the
whole of it, the result or the rejection and the fingerprint of the command's payload, is
encrypted under every key that person holds in force, one inside the other, and under one of each
category the payload holds a value of, created when they hold none; a rejection is also encrypted
under the keys of everyone whose data the state it was decided on held, as they were read. An
answer that concerns nobody is encrypted under the [database's key](#three-keys-deep). The key a
caller chose, which may quote someone too, is sealed with the answer, and the answer is filed under
an HMAC of it, under a key derived from the database's. The answer also names the
[marks](#marking-a-field-later) it was sealed under: one sealed under other marks may quote, in the
clear of any key of today, what the marks of today make personal, so a replay of it rejects with
`IdempotentAnswerErasedError`, and the walk of the backfill erases it. An answer kept by an earlier
version, filed under the key itself and in the clear, is erased and filed under the key's HMAC
before the first lookup that misses, so a retry of what it recorded is refused instead of run
again, and by the walk too.

Forgetting any category of anyone an answer names destroys a key it needs: the answer no longer
opens anywhere, in the database or in any copy of it, without being found. `forget` also erases it
in the live store, leaving the key alone, and so does a [redaction](#correcting-a-persons-data) of
the person's data, which may have changed what it quotes. A dispatch under that key then rejects
with `IdempotentAnswerErasedError` (`IDEMPOTENT_ANSWER_ERASED`) and runs nothing until the key
expires: a late retry neither repeats what the command did nor brings back data the person had
erased. Its payload is not compared any more, since its fingerprint went with the answer. Replaying
an answer is processing the person's data, so a [restriction](#restricting-processing) of anyone
it names refuses it, as it would refuse the command, unless the dispatch names a basis with
`processRestricted`. The export hands out the answers remembered of the person in `answers`.

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
  categories: {
    default: { basis: null, retention: "730d", restrictedUntil: null },
    profile: { basis: "contract", retention: "30d", restrictedUntil: null },
    invoices: { basis: "legal-obligation", retention: "6y", restrictedUntil: null },
  },
  restrictions: [
    { ground: "accuracy-contested", categories: ["invoices"], since: "2026-02-20T09:00:00.000Z" },
  ],
  redactions: [
    { eventId, at: "2026-02-21T09:00:00.000Z", events: [{ id, fields: ["phone"] }] },
  ],
  recipients: [
    { port: "customer.mailer", name: "Mailchimp", kind: "processor", country: "US",
      transfer: { safeguard: "standard-contractual-clauses" }, status: "disclosed",
      categories: [{ name: "profile", basis: "contract" }],
      firstDisclosedAt: "2026-02-01T09:00:00.000Z", lastDisclosedAt: "2026-02-20T09:00:00.000Z",
      declared: true },
  ],
  events: [
    { id, type: "CustomerRegistered", aggregateType: "customer", aggregateId: "c-42",
      version: 1, position: 17, timestamp, data: { email: "ana@example.com", phone: null },
      categories: { email: "default", phone: "default" }, restricted: [],
      redacted: ["phone"] },
    { id, type: "OrderPlaced", aggregateType: "order", aggregateId: "o-9",
      version: 1, position: 40, timestamp,
      data: { billingAddress: "1 Main St", deliveryNote: "ring twice" },
      categories: { billingAddress: "invoices", deliveryNote: "profile" },
      restricted: ["billingAddress"], redacted: [] },
  ],
  scheduledCommands: [
    { commandId, type: "RemindCustomer", executeAt, data: { email },
      categories: { email: "default" }, restricted: [] },
  ],
  deadLetters: [
    { id, kind: "policy", handler: "customer.welcomeOnCustomerRegistered",
      errorMessage: "no mailbox for ana@example.com", errorStack, data: {}, categories: {},
      restricted: ["errorMessage", "errorStack"] },
  ],
  subscriberFailures: [
    { subscriber: "projection:customerDirectory", eventId, eventType: "CustomerRegistered",
      errorMessage: "cannot index ana@example.com", errorStack,
      restricted: ["errorMessage", "errorStack"] },
  ],
  answers: [
    { idempotencyKey: "confirm-7", expiresAt,
      outcome: { rejected: "NotYet", message: "ana@example.com cannot be confirmed yet",
        aggregateType: "customer", aggregateId: "c-42" },
      restricted: ["outcome"] },
  ],
  readModels: {
    customerDirectory: [
      { key: "c-42", data: { email: "ana@example.com" }, categories: { email: "default" },
        restricted: [] },
    ],
    orderSummary: [{ key: "o-9", data: {}, categories: {}, restricted: [] }],
  },
}
```

`categories` describes every category of the app, as article 15(1) of the GDPR asks: why it is
processed, its `basis`, `null` for the default category, which declares none; how long it is kept
after their last activity, its `retention`, `null` when nothing forgets it for inactivity; and,
for a category a legal obligation kept past a forgetting, when what was kept goes,
`restrictedUntil`. Every record lists the category of each field of its `data` in `categories`.

`restrictions` are the [restrictions](#restricting-processing) the person asked for and has not had
lifted, one per ground, with the categories each covers, `null` for the person as a whole, and
since when; a lift announced is among `events`, as `ProcessingRestrictionLiftAnnounced` with
`liftsAt`. Restricted data is still in the export, since the right of access holds: every record
says in `restricted` what of it a restriction covers, the fields of `data` of a restricted
category, or kept under a legal obligation, or every one for a person restricted as a whole, and
`errorMessage` and `errorStack`, or an answer's `outcome`, while any restriction holds, since an
error's text or a rejection's message may quote any of their data.

`redactions` are the [redactions](#correcting-a-persons-data) of their data, in the order they
were made, each with the id of its `PersonalDataRedacted`, when, and the events and fields it
sealed, never a value: every event says in `redacted` which fields of its `data` a redaction
sealed, and those read `null`.

`recipients` are the [recipients](#recipients) of their data, as `recipientsOf` lists them: each
one disclosed data of theirs, presumed to hold it, or declared for a category of theirs, with the
categories concerned and their basis, its country and the safeguard of a transfer out of the
European Economic Area, as article 15(1)(c) asks.

`events` are every event that names the person, by its field marked `person` or its aggregate's
id, in position order, the events of their own stream `bounda:<personId>` included; `data` holds
the fields marked `personal` of that event, opened, and nothing else of its payload, so an event
without such fields has an empty `data`. A process's lifecycle event names the person [its state
names](#in-a-processs-state), and its `data` holds the personal fields of that state. `scheduledCommands` are the commands waiting to run
whose payload holds personal fields of theirs, with `commandId` the id the dispatch answered or,
for one the runtime scheduled itself, the scheduler's key, each with the same `data`.
`deadLetters` are the handler runs that gave up and name the person: work about them, whose
`errorMessage` and `errorStack` are encrypted with their keys and come out opened, and the
scheduled commands whose payload holds their fields, with its `data`. `subscriberFailures` are the
last failures of the subscribers on an event that names them, kept with their error text
encrypted with their keys (see [observability](/reference/observability/#error-text)), opened.
`answers` are what the commands dispatched with an idempotency key that concern them answered, as
long as each is [remembered](#remembered-answers) and opens, opened. After `forget`, the person's events and letters are still theirs, and every field and error text
reads as `null`, as a handler reads it. `readModels` has an entry for every read model with a field marked
[`.person()`](#personal-data-in-read-models): the rows whose person field holds the id, each
with its primary key as `key`, so the person can tell them apart, and its fields marked
`.personal()` as `data`, read through the read model's own storage, which may be another
adapter's, in pages by primary key, so a projection that writes a row meanwhile cannot make
another skip or repeat. An empty id is refused with `ValidationError`.

Only what is marked comes out, and that is the limit to know: a field left unmarked is not
personal data to Bounda, so the rest of `OrderPlaced` is the order's and stays out; a read model
without a person field is a view Bounda cannot tell is about anyone, and whatever a port sent out
is at the mailing provider or the search index, which `recipients` names. An app that owes a person
more than their marked fields takes this export and adds what it knows from its ports. An event stored before its
type marked its fields is found once the [backfill](#marking-a-field-later) has sealed it.

Each store keeps the person an event names in a `person` column, indexed with the position, and
the adapters read by it with `readByPerson`; a scheduled command is found by the `persons` it
carries, and a dead letter by its `person`, its `statePerson` or its `persons`. `forget` and the export find those
rows, and the snapshots and remembered answers `forget` removes or erases, through an index, never by
reading every row: PostgreSQL indexes the `persons` column itself, and SQLite, the Durable Object
included, keeps a table of which row names which person, written and removed by the same statement
as the row.

## Correcting a person's data

A person may ask that data of theirs that is wrong be corrected: the right to rectification,
article 16. Events are facts, so the corrected value is a new event of the app's own, and the wrong
one, kept in events that are never deleted, is sealed for good with `redact`, which is on every
`BoundaClient`, next to `forget`:

```ts
const exported = await app.exportPersonalData("c-42");
const wrong = exported.events.flatMap((event) =>
  event.data.email === "ana@old.example"
    ? [{ ...event, fields: ["email"] }]
    : [],
);
await app.redact("c-42", { events: wrong });
await app.commands.correctEmail({ customerId: "c-42", email: "ana@new.example" });
```

`redact` takes the events whose fields hold the wrong value, each as the person's
[export](#exporting-a-persons-data) lists it, its `aggregateType`, `aggregateId`, `type` and `id`,
with the `fields` to seal, so an export record spread with `fields` is a target. The types say which
fields each event type marks `personal`: a field the type does not mark, or an event type that marks
none, does not compile, and a process's lifecycle events that carry its state, `ProcessStarted`,
`ProcessHandled`, `ProcessDeadlineReached` and `ProcessTimedOut` of the stream
`process:<aggregate>.<process>`, take the fields its [state](#in-a-processs-state) marks. Every
event named must name the person: one the store does not hold, of another type or about another
person is refused with `ValidationError`, as are no events, no fields and an empty id, before
anything is redacted or recorded. Redact before you append the correction, so a copy of the old value a read model
quotes in a field is never confused with the new one.

In one transaction it opens each field under the person's key and seals the value anew under a key
made for the redaction and let go at once, in place, so from then on the field reads as `null`, as
a forgotten one does, in every event, under every key and in every copy of the database restored
from then on; it appends `PersonalDataRedacted` to the stream `bounda:<personId>`, with the events
and fields it reached, the categories of the values, and the scheduled commands and dead letters it
removed, never a value. In the same transaction the
[snapshots](/concepts/long-streams/#snapshots) of those streams go, as do the person's remembered
rejections, which may quote the old value; a scheduled command whose payload holds an old value,
equal to it or quoting it, is cancelled, and a scheduled command's dead letter that holds one is
removed, as `forget` cancels and removes them; and the error text of a dead letter that quotes one
is sealed for good, the letter left in place. It resolves like a command, so `catchUpReadModels({
through })` waits for the read models, and the Durable Object's `redact` and the one in React
Router's `bounda` context wait for them themselves unless `consistency` is `"eventual"`. A field
that no key of the person opens any more, redacted or forgotten already, is left as it is, and
nothing left to redact appends nothing and resolves without events, so redacting the same field
twice appends once. A field moved to [another category](#changing-a-category) is opened under the
key it was sealed anew under, and a field a forgetting [kept under a legal
obligation](#categories) is redacted all the same.

Everything that reads the field reads `null` from then on: `begin` and `evolve`, so the
aggregate's state has the field `null` until the correction sets it; a policy or process that
handles the event afterwards; an [upcaster](/guides/changing-events/), which runs on the payload
opened; a [rebuild](/guides/deployment/#rebuilding-a-read-model), which replays the event as it
reads now; and the export, which marks the field `redacted` on the event and lists the person's
`redactions`. The types say so already, `string | null`, as for a forgotten field. The access log
records nothing of a redaction, which hands nothing out.

A read model holding the person's personal fields writes over its copies when it projects
`PersonalDataRedacted`, before its own projection of the event, if it has one, runs. One that
projects an event type the redaction reached may keep what it derived from the old value without
quoting it, a hash or a value reformatted, so every field marked `.personal()`,
[sealed](#sealed-at-rest) or [in the clear](#in-the-clear), of the rows whose field marked
`.person()` names them reads `null` from then on, the values it did not derive from the old one
too, its blind indexes emptied; the worker then [rebuilds](/guides/deployment/#rebuilding-a-read-model)
it in the background, a few batches of `dispatcher.batchSize` events a pass, into a shadow table while
queries read the live one, and once the shadow takes its place the rows read as the events now do:
the correction's value where a projection wrote it, the rest as before. A rebuild of it under way
goes on from where it stood, after a restart too: one that started before the redaction, and may
have copied the old value, hides the person's values in its table as well, and another follows it. Any other read model with personal fields
writes `null` over each personal field of the person's rows that holds an old value, equal to it or
quoting it as [`expectRedacted`](#in-tests) finds a value, so a note that quotes the old email reads
`null` and the rest stays. A field kept in the clear that cannot hold `null`, because it is not
`.optional()` or it is the primary key, would keep the old value for as long as the row is there,
so the row is deleted instead, for the rebuild or a projection of the correction to write again. A
read model that projects such an event says whose its rows are or that it holds no personal data
([see above](#personal-data-in-read-models)), so none serves what it derived from an old value
without the app having said so: a field it does not mark `.personal()` is one the app states holds
nothing of the person's.

The old values wait for this, sealed under the person's keys as the events held them, in an entry of
the scheduler that names nobody, until every read model with personal fields, and every rebuild of
one under way, has projected the redaction and every read model to rebuild has been rebuilt from
after it, each on its own database included; the worker then removes it, and makes unreadable what
work that read the old value just before the redaction committed wrote of it after: an event of the
person holding it gets a redaction of its own, a scheduled command or a dead letter goes as above,
and a subscriber's last failure on an event of theirs, or kept in the clear, that quotes it has its
text sealed for good. The entry is part of the database, so a crash or a restart only pauses it; a
read model that fails keeps it, and with it the old values, until it projects the redaction, and a
rebuild that fails is tried again a poll later: the lag in `getLag` and `bounda status`, and the
worker's log, show both.

A person who [contested the accuracy](#restricting-processing) of their data is usually restricted
while it is checked: `redact` is allowed then, as `forget` and the export are, and the command that
appends the correction names the person's consent, `app.commands.correctEmail(payload, {
processRestricted: "consent" })`, before the restriction is lifted with `unrestrict`. With a
[forget ledger](#backups), a redaction is in the ledger before it commits, with the events and
fields it was asked for, and a restore of a copy taken before it, or a commit that never happened,
redacts them again at the next reconciliation, under its own id and time; without a ledger,
`bounda restored` and `redact` again are how an operator puts it back. A redaction racing a
forgetting is settled by whichever commits first, the other finding nothing left to open. Every
[recipient](#recipients) that received data of the person in a category redacted is told, and a
read model may project the event from `projections/bounda/personal-data-redacted.ts`, typed
`PersonalDataRedactedEvent`.

From the command line, `bounda redact <person> --from <file>` reads the events, one a line as JSON
(see [the CLI reference](/reference/cli/#bounda-redact)).

## Personal data in read models

A read model that projects an event with personal fields has copies of them in its rows. Its
view marks them, as an event's payload does, with two methods of the field builder:

```ts
// app/read/customer-directory/view.ts
import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  customerId: f.string().primaryKey().person(),
  email: f.string().personal().unique(),
  plan: f.string().notPersonal(),
});
```

`.person()` marks the column that holds the id of the person the row is about, a `string`
column, at most one per read model. A person who appears in many rows, such as a customer in an
order summary, is marked on that foreign column (`customerId: f.string().index().person()`), with
its own index if the export of a person with many rows must be fast. `.personal()` marks a column
that holds their personal data, in the default [category](#categories) or the one it names
(`.personal({ category: "invoices" })`). The person's [export](#exporting-a-persons-data) includes
the rows that name them, and a [query](#who-opened-what) of a read model with personal fields is
recorded in the access log.

A value derived from a person's data is their data too, a hash of their email as much as the email,
so a read model that projects an event with personal fields says whose each row is with `.person()`,
which lets a [redaction](#correcting-a-persons-data) hide the person's values at once, or states in
its view that it keeps nothing of anyone's data, nor anything derived from it:

```ts
// app/read/orders-per-day/view.ts
import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  day: f.string().primaryKey().notPersonal(),
  orders: f.number(),
  total: f.number(),
});

// Counts and totals: nothing of the address or the note on an order.
export const holdsPersonalData = false;
```

A read model that does neither does not compile in `.bounda/types.ts`, and the app refuses to start
with `ConfigurationError`, naming the events. One that states it marks no field `.personal()` or
`.person()`, a redaction neither hides nor rebuilds it and a forgetting leaves it as it is: the
statement is the app's, and so is anything it keeps that the statement leaves out.

### Sealed at rest

A column marked `.personal()` is sealed: the runtime encrypts each value under the key of the
row's person in the column's category, as it does an event's field, and the table holds only the
envelope. Projections write the value and read it back as it was; queries read it opened. Whatever
goes around them sees ciphertext: a statement run on the database, a copy or a backup of it,
`client.raw`. Beside it the table keeps `<column>__key`, the fingerprint of the key the value went
in under, which says nothing of the value.

Once the person's category is forgotten its key is gone, so the column reads as `null` from then
on, in every copy of the table ever made: forgetting does not depend on what the read model's
projections do, and a read model needs no projection of `PersonalDataForgotten` for a sealed
column. The row type says so: a sealed column reads `T | null`. A read model that would rather drop
the rows of a forgotten person still projects the event and deletes them.

Which key a value goes in under is the runtime's to say: the one the event being projected was
opened under for that person and category, so a rebuild puts every row under the key it was first
written under; else the one the person holds; else the last a forgetting kept. A row with a
personal value and no person in its `person` column is refused with `ConfigurationError`. A value
of a person who holds no key in its category, because the event carried no personal data of theirs
in it, is written under a key no one keeps and reads as `null`: mark the event's field too, in the
same category.

A sealed column is never sorted (`orderBy` refuses it) nor filtered by range. `.index()` or
`.unique()` gives it a blind index instead, `<column>__index`: an HMAC-SHA256 of the value under
the database's index key, apart for each read model and column, so `where` matches it by equality,
`ne` or `in`, and `.unique()` holds on it.

```ts
// app/read/customer-directory/queries/by-email.ts
export const repository = ({ table, email }: Query.RepositoryArgs) => table.findOne({ email });
```

Hand-written SQL compares the index column to what `client.blindIndex(field, value)` computes:

```ts
export const repository = async ({ client, email }: Query.RepositoryArgs) =>
  client.get('SELECT * FROM "bounda_rm_customer_directory" WHERE "email__index" = ?', [
    await client.blindIndex("email", email),
  ]);
```

The index key is one random key per database, created when the first read model with a blind
index starts and kept wrapped under the [key wrapper](#where-the-keys-live) as the persons' keys are,
rewrapped with them when the master key rotates: a copy of the database computes no index without
it. Forgetting empties the index of each value whose key it destroyed, so a forgotten email no
longer matches anything, nor tells two forgotten rows apart, and its key field then reads
`forgotten`.

### In the clear

A column that SQL must sort or filter by range is kept in the clear with
`.personal({ clear: true })`. It is stored as it is, so the read model must project
`PersonalDataForgotten` from `projections/bounda/personal-data-forgotten.ts`, or
`.bounda/types.ts` does not compile and the app does not start:

```ts
// app/read/customer-directory/projections/bounda/personal-data-forgotten.ts
import type { Projection } from "./+types/personal-data-forgotten";

export const project = async ({ event, table }: Projection.Args) => {
  await table.delete({ customerId: event.payload.personId });
};
```

What it does is the read model's business: delete the row, as here, keep it without the personal
columns by upserting it again without them, or keep a count. Its payload says which
[categories](#categories) went: `categories`, every one but those a legal obligation kept when the
person was forgotten as a whole, and only those named when a consent was withdrawn (`whole:
false`). A read model clears what it holds of those categories alone, so a newsletter's subscribers,
all of them `marketing`, go when that category does, and stay when only an invoice is at stake:

```ts
// app/read/newsletter/projections/bounda/personal-data-forgotten.ts
import type { Projection } from "./+types/personal-data-forgotten";

export const project = async ({ event, table }: Projection.Args) => {
  const { personId, categories } = event.payload;
  if (categories.includes("marketing")) await table.delete({ subscriberId: personId });
};
```

A column in the clear is read as it is by a direct read of the table, a copy and `client.raw`, and
the access log records a query that takes `client.raw` on such a read model as unattributed. A
projection of a personal event handles `null` as well, since a rebuild replays every event, the
forgotten ones included: a column in the clear that is `NOT NULL` takes a `null` email badly, so
make it optional and leave it out. A sealed one takes it: `null` is sealed like any value.

A copy keeps a column in the clear as it was, a forgotten person's included: that is what `clear`
costs. Once the tenant is forgotten, how long a copy keeps it depends on the engine. SQLite through
libSQL [encrypts the file](#encrypted-database-files) under the tenant's key, so no copy opens.
PostgreSQL has no encryption of its own under a key per tenant ([PostgreSQL
wiki](https://wiki.postgresql.org/wiki/Transparent_Data_Encryption)), so a copy keeps the column
for as long as you keep the copy. A Durable Object empties its storage, but Cloudflare keeps its
[point-in-time history](https://developers.cloudflare.com/durable-objects/api/storage-api/) for 30
days, encrypted under [keys of its
own](https://developers.cloudflare.com/durable-objects/reference/data-security/), not the
tenant's. Wherever a copy is restored under the app, the tenant is forgotten in it again before it
serves anything, and an app names, once as it starts, the fields kept in the clear in a database not
encrypted under the tenant's key. To keep a column readable in no copy, seal it: `.personal()`
without `clear`, found by equality through its blind index, never sorted or filtered by range.

### What a forgetting kept

A category a legal obligation keeps past `forget(person)` is restricted until its retention ends
(see [Categories](#categories)). The runtime marks the key field of each value written under the
key it kept, so a query leaves those rows out but on the `legal-obligation` basis or one of article
18(2), and the export marks those fields restricted. A person who comes back gets a new key: what
is written of them from then on goes under it and reads as any other row, while the rows from before
stay out of sight. When the kept key's retention ends the key goes, and the old values read as
`null`, while the new ones still read: the key, not the text, tells them apart.

### Written around the runtime

A projection that takes `client.raw` writes through the driver, around the runtime. Whatever it
leaves in a sealed column in the clear, or in a personal column without its key field, is sealed
before the batch commits, so nothing it wrote in the clear is ever stored. A projection that writes
a value of another person through the driver still names the row's person in the `person` column.

### Changing a column's mark

A read model whose personal columns change, a column newly sealed, kept in the clear, or given a
blind index, goes through its rows once when the app starts, before anything reads them, a page per
transaction: a value in the clear in a column now sealed is sealed, an envelope in a column now kept
in the clear is opened, a missing key field or blind index is filled. A column whose stored type
changes needs a rebuild, as any such change does: on SQLite a `number` or `boolean` column newly
sealed, which becomes text, and on PostgreSQL any but a `string` one. A primary key is never
sealed, and a field whose name ends in `__key` or `__index` is refused, since the runtime keeps
those columns.

## Who opened what

Accountability asks to know who opened whose personal data. Every operation that hands out a
person's data in the clear records it, once per call:

| Operation | `persons` | `detail` |
| --- | --- | --- |
| `exportPersonalData` | the person | `{ events, scheduledCommands, deadLetters, subscriberFailures, answers, readModelRows, recipients }`, how many of each; `null` when it failed |
| `recipientsOf` | the person | `{ recipients }`, how many; `null` when it failed |
| `disclosure`, a call to a [recipient's](#recipients) port | those whose data of the recipient's categories the work read | `{ recipient, handler, categories }`: the port, the command, policy, process or query, and the categories recorded as disclosed |
| `recipientNotice` | the person the event is about | `{ recipient, event, eventId, categories, superseded }`: whom it told of what, ids and categories alone |
| `deadLetters.list` | those the letters name | `{ letters }`, how many |
| `deadLetters.get`, `retry`, `discard` | those the letter names | `{ letter }`, its id |
| `subscriberFailures.list` | those the failures' events name | `{ failures }`, how many |
| `subscriberFailures.get` | the one the failure's event names | `{ subscriber }`, its name |
| a query of a read model with fields marked `.personal()`, or of one with a field marked `.person()` that names `includeRestricted` | those the `person` field names in the rows the query read | `{ query, readModel }` |
| `command`, `policy`, `process` | the restricted persons whose data it read on its [basis](#processing-restricted-data-anyway) | `{ handler }`, the command's type or the policy's or process's key |

Each record is `{ operation, actor, persons, personCount, at, outcome, restricted, detail }`, and a
query's adds `unattributed`. `restricted` is `{ basis, persons, personCount }` for a call that read
restricted data on a basis it named, `includeRestricted` or `processRestricted` or a module's
`restricted`, the persons whose restricted data it opened, and `null` for every other: `actor` is the client's, from
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
`client.raw`, the driver itself, reads its fields [sealed at rest](#sealed-at-rest) as ciphertext,
which opens for no one, but those [kept in the clear](#in-the-clear) as they are: on a read model
with such a field it is recorded with `unattributed: true`, which says that `persons` names only
those of the rows read through `table` and `client`, and whose rows it read through the driver is
unknown. A query that composes another
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

## Recipients

What a port sends out stays out: the mailing provider has the contact, the CRM has the address.
The GDPR calls whoever receives a person's data a recipient, and asks three things of the
controller about them: to tell each one of a rectification, an erasure or a restriction of the data
it received (article 19), to tell the person who they are when asked (article 19 and article
15(1)(c)), and to say where a transfer out of the European Economic Area goes and on what it rests
(articles 44 to 49). A port says it is a recipient in its own module, next to its interface:

```ts
// app/domain/customer/mailer.ts
import type { Port } from "./+types/mailer";

export interface Mailer {
  welcome(args: { email: string; idempotencyKey: string }): Promise<void>;
  erase(args: { personId: string; idempotencyKey: string }): Promise<void>;
  suppress(args: { personId: string; idempotencyKey: string }): Promise<void>;
  resume(args: { personId: string; idempotencyKey: string }): Promise<void>;
}

export const recipient = {
  name: "Mailchimp",
  kind: "processor",
  country: "US",
  safeguard: "standard-contractual-clauses",
  categories: ["contact"],
} satisfies Port.Recipient;

export const onPersonalDataForgotten = ({
  event,
  mailer,
  idempotencyKey,
}: Port.OnPersonalDataForgottenArgs) =>
  mailer.erase({ personId: event.payload.personId, idempotencyKey });

export const onProcessingRestricted = ({
  event,
  mailer,
  idempotencyKey,
}: Port.OnProcessingRestrictedArgs) =>
  mailer.suppress({ personId: event.payload.personId, idempotencyKey });

// The person is told by the app; the provider has nothing to do until the lift.
export const onProcessingRestrictionLiftAnnounced = async (
  _args: Port.OnProcessingRestrictionLiftAnnouncedArgs,
) => {};

export const onProcessingRestrictionLifted = ({
  event,
  mailer,
  idempotencyKey,
}: Port.OnProcessingRestrictionLiftedArgs) =>
  mailer.resume({ personId: event.payload.personId, idempotencyKey });

// The corrected value reaches it as the app's own event does; the old one goes.
export const onPersonalDataRedacted = ({
  event,
  mailer,
  idempotencyKey,
}: Port.OnPersonalDataRedactedArgs) =>
  mailer.erase({ personId: event.payload.personId, idempotencyKey });

// The tenant was forgotten: every person whose data the port sent goes.
export const onTenantForgotten = async ({ persons, mailer }: Port.OnTenantForgottenArgs) => {
  for await (const personId of persons()) await mailer.erase({ personId });
};
```

`recipient` names who receives the data, as the person is told; its `kind`, a `processor` that
processes it on the app's behalf (article 28), a `joint-controller` (article 26) or a `third-party`
with purposes of its own (article 4(10)); its `country`, as an ISO 3166-1 alpha-2 code; and the
[categories](#categories) of personal data the port sends it. A country outside the European
Economic Area takes the `safeguard` its transfer rests on: `adequacy` (article 45),
`standard-contractual-clauses` (article 46(2)(c)), `binding-corporate-rules` (article 47),
`code-of-conduct`, `certification` (article 46(2)(e) and (f)) or `derogation` (article 49); one
inside takes none. A port of a read model may declare one too, for what its queries hand it.

Five of the six handlers tell the recipient of one event of the person's stream `bounda:<personId>`:
a [forgetting](#forgetting-a-person), a [restriction](#restricting-processing), the announcement of
its lift, which article 18(3) asks be made before it, the lift, and a
[redaction](#correcting-a-persons-data). The sixth, `onTenantForgotten`, tells it the whole tenant
was [forgotten](#forgetting-a-tenant), with `persons()` in place of a person. It receives the event, typed; `categories`, of those the
recipient received, the ones the event touches; for a forgetting, `retained`, those a [legal
obligation keeps](#categories) instead, which the recipient restricts rather than erases;
`presumed`, `true` when it is not known to hold the data but cannot be ruled out (see below);
`idempotencyKey` and `signal`, as a policy's; and the port, under its name. A handler that has
nothing to do with an event, as one whose provider has no notion of an announced lift, says so by
doing nothing: the generator types every handler, `.bounda/types.ts` fails to compile while the
module declares a `recipient` and lacks one of them, or while a method of the port answers
something other than a promise, naming the port and the event, and the app refuses to start on the
same, and on a declaration without a name, a kind, an ISO country, the safeguard of a transfer, or
categories the app has.

### What was disclosed

A recipient is told only of what it received. Each call a command, a policy, a process step or a
query makes to a recipient's port first records, in its own transaction, as disclosed to it the
data of the recipient's categories the run had read: the person, the port, the recipient as
declared then, with its country and safeguard, and the category, ids and names alone, never a
value. What the run read of other categories is not recorded: the declaration is the app's word for
what the port sends. A run that read nothing of anyone's, or only the ids, discloses nothing.

The same transaction refuses the call, before the port is reached, when the person's stream moved
past what the run read: a forgetting, a restriction, a lift or a redaction committed after the read
throws a `ConcurrencyError`, and the run is tried again on the data as it is now, as a command is
after a race. A query's data is the read model's, so its read is fenced by where the read model
stands: its checkpoint, or past the events after it that it does not project. One that lags behind
a forgetting or a redaction refuses the call until it projects it; a change it does not project,
such as a restriction, holds nothing up. The
transaction also refuses, with [`ProcessingRestrictedError`](/reference/errors/), data a
restriction covers that the run names no [basis](#processing-restricted-data-anyway) for. So a
disclosure is either recorded before the event that tells its recipient commits, and the event
names it, or refused, never handed over unseen.

### Who is told, and how

Each of the six events names, in `recipients`, the recipients to tell, read in its own transaction
from what was disclosed: every port that received data of the person in a category the event
touches, with those categories, `retained` and `presumed`. The event is the outbox. A subscriber of
its own, `recipients`, hands each one to the port's handler, once at least and in the order of the
person's events, with the timeout, retries and back-off of the policies of the port's aggregate,
[`policies.timeout` and `policies.retry`](/reference/configuration/#policies); a handler that keeps failing is filed as a
[dead letter](/guides/dead-letters/) of kind `recipient`, its handler the port, which
`app.deadLetters.retry` tells again and `discard` closes once the recipient was told by hand. A
recipient whose notice waits for a retry is handed none of its later ones meanwhile. Each notice
handed out is recorded in the [access log](#who-opened-what), as `recipientNotice`. A forgetting
removes the disclosures it forgot: its event keeps whom it told.

A notice of a restriction, a lift or a redaction that a later forgetting of the person as a whole
told the same recipient is superseded: it is not handed over, since it would only bring back what
the recipient had to erase, and the access log records it with `superseded: true`. So a dead letter
of a restriction outlives the person's forgetting, and retrying it afterwards changes nothing.

### Recipients declared late, renamed or removed

A port declared after the store already held events may have sent data no one recorded. Its
recipient is presumed to hold every category it declares of every person whose data existed then:
each event of theirs names it with `presumed: true`, until a forgetting told it to erase them; and
the worker tells it, presumed, in order, of every forgetting, restriction, lift and redaction the
store recorded before it was declared, a batch of events per pass, while its later notices wait.
`bounda status` says so for as long as it lasts.

A port renamed keeps what its recipient holds when the new one lists the old key, `"<aggregate or
read model>.<port>"`, in `recipient.formerly`: the app moves its disclosures to the new port when it
starts, and an event that named the old one tells the new one. A port whose recipient holds data and
that the app no longer declares is logged at start; whatever it should be told of is filed at once
as a dead letter with `ConfigurationError`, for an operator to declare it again, or to tell the
recipient by hand and discard the letter.

### Restores

With a [forget ledger](#backups), the first disclosure of each category of a person to a recipient
goes to the ledger before the port is called, so a restore that loses it records it again at the
next reconciliation, unless a forgetting of that category came after it. Without one, once the
database is known to have gone back, by `bounda restored` or the restore watch, every recipient is
presumed to hold the data of every person whose data existed then.

### Telling the person

`recipientsOf(personId)` on every `BoundaClient` lists the recipients of the person's data, as the
person may ask (article 19): those disclosed data of theirs, with the identity the port declared
then and when it was first and last recorded; those presumed to hold it; and those declared for a
category the person has data of that received none yet and may (article 15(1)(c) asks for those
too). Each one with its `port`, `name`, `kind`, `country`, `transfer`, the safeguard of one out of
the European Economic Area or `null`, its `status`, `disclosed`, `presumed` or `declared`, the
`categories` concerned with their basis, and `declared`, `false` for a port the app no longer
declares. The [export](#exporting-a-persons-data) lists the same as `recipients`. Each call is
recorded in the access log, as `recipientsOf`. From the command line:

```sh
bounda recipients c-42
bounda recipients
```

The first prints the person's as JSON; the second, every recipient, how many persons were disclosed
to it, whether it is still being told what came before it, and its failed notices (see
[the CLI reference](/reference/cli/#bounda-recipients)).

## Restricting processing

A person may ask that their data be kept but not processed for a while: the GDPR's restriction of
processing, article 18. `restrict` is on every `BoundaClient`, next to `forget`, and takes the
ground of article 18(1) the restriction rests on:

```ts
const restricted = await app.restrict("c-42", { ground: "accuracy-contested" });
await app.catchUpReadModels({ through: restricted });
```

| Ground | Article 18(1) | When |
| --- | --- | --- |
| `accuracy-contested` | (a) | the person contests the accuracy of their data, while it is verified |
| `unlawful-processing` | (b) | the processing was unlawful and the person asked to keep the data rather than erase it |
| `legal-claims` | (c) | the app no longer needs the data and the person needs it for a legal claim |
| `objection-pending` | (d) | the person objected under article 21(1), while the objection is weighed |

Without `categories` the person is restricted as a whole; `restrict("c-42", { ground:
"accuracy-contested", categories: ["contact"] })` restricts those [categories](#categories) alone,
as when the person contests one kind of data. A person may hold several restrictions at once, one
per ground, each with the categories it covers; restricting as a whole on a ground takes the place
of the categories restricted on it. In one transaction `restrict` records the restriction and
appends `ProcessingRestricted` to the stream `bounda:<personId>`, with the ground, the categories
and every restriction the person has after it, ids and names alone, and it resolves like a
command, so `catchUpReadModels({ through })` waits for the read models, and the Durable Object and
React Router wait for them themselves unless `consistency` is `"eventual"`. A restriction that adds
nothing appends nothing and resolves without events. An empty id, a ground the article does not
name, or categories that are empty or that the app does not have are refused with
`ValidationError`.

What a [forgetting kept under a legal obligation](#categories) is restricted too, without anyone
asking: kept for the law alone, and for nothing else, until its retention ends.

### What restricted means

Restricted data is kept and nothing else, as article 18(2) asks. From the moment the restriction
commits:

- **Commands.** A command that touches a person restricted as a whole is refused with
  [`ProcessingRestrictedError`](/reference/errors/) (`PROCESSING_RESTRICTED`, with the id in
  `personId`) before it runs, and before it is scheduled when it has a `delay`: one whose payload
  names them with `person`, or whose aggregate is the person. So is one whose aggregate's events
  hold data the restriction covers, a field of a restricted category or anything of a person
  restricted as a whole, whoever the command is for, before its handler runs, since the handler
  could hand what it read to a port: an order of a restricted customer is not shipped to the
  address they contest. The store checks again, in the transaction that would write the events,
  that nobody they touch is restricted as a whole and that no field they seal is of a restricted
  category, so a command running when `restrict` commits stores nothing it decided after. `app.commands`
  throws the refusal; nothing is recorded under an `idempotencyKey`, so the same request sent once
  the restriction is lifted runs. An answer already [remembered](#remembered-answers) under a key
  is not replayed either while a restriction covers anyone it names, any category of theirs
  included, since it may quote any of their data.
- **Reactions.** A policy whose event is about a person restricted as a whole, by its `person`
  field or because its aggregate is the person, though it carries none of their data, or whose
  event holds data a restriction covers, a step of a process whose event or [state](#in-a-processs-state) does, and a
  scheduled command whose payload does, wait as a dead letter with `errorCode:
  "PROCESSING_RESTRICTED"` and the person in `person`, before the handler runs. So does a reaction
  whose command is refused, even when the event it handled names nobody: a policy on `Invited`,
  an event of the newsletter, dispatching `registerCustomer` for the restricted customer. A policy
  on the runtime's own events, `PersonalDataForgotten` and the restriction events, runs: they carry
  ids alone, and telling the person is what such a policy is for. So are the notices to
  [recipients](#recipients), and a disclosure to one of data a restriction covers is refused as a
  command would be.
- **Queries.** A query leaves out every row of a read model whose field marked
  [`.person()`](#personal-data-in-read-models) names a person restricted as a whole, or restricted
  in a category a field of the read model marked `.personal()` holds, and every row holding a value
  under a key a forgetting kept ([What a forgetting kept](#what-a-forgetting-kept)). `table` leaves
  them out in the statement itself, so a page and a count are cut after; `client.get` and
  `client.all` drop them from what their SQL answers. A sealed value names its person, so a
  statement need not select the `.person()` field; one that selects a field kept in the clear
  without it is refused with `ConfigurationError`, as is one that selects such a field of a person
  a forgetting kept a key of without the primary key, which tells which key the row's value is
  under. Nothing else opens a value of a restricted person: a direct read of the table and
  `client.raw` see ciphertext. Queries read who is restricted from a copy kept
  beside the read models, written from the stream as a projection is, so a query right after
  `restrict` may still read the rows until the copy catches up: `restrict` resolves like a
  command, so `catchUpReadModels({ through })` waits for it. See
  [Queries](/guides/read-models/#restricted-rows).
- **Dead letters and subscriber failures.** `deadLetters.list` and `get` keep a letter that names a
  restricted person sealed, its error text and fields reading as `null`, and say `restricted: true`;
  so do `subscriberFailures.list` and `get`.
- **What a forgetting kept.** A command, a policy or a process step reads a field opened under a
  key a forgetting kept as `null`, as if forgotten: those keys are never lifted, so nothing waits
  for them, and the business goes on with the rest. A query leaves the row out unless it reads on
  `legal-obligation`.

Projections keep storing, since storing is what a restriction keeps, and a rebuild replays every
event. `forget` and the export stay allowed: a restriction is not an erasure, and the right of
access holds. The export lists the person's `restrictions` and, on each record, the fields a
restriction covers in `restricted`; see [Exporting a person's data](#exporting-a-persons-data).

### Processing restricted data anyway

Article 18(2) allows restricted data to be processed on the person's consent, for legal claims,
to protect the rights of another person, or for an important public interest. Bounda never assumes
one: the call names it, and the [access log](#who-opened-what) records it.

| Basis | Opens |
| --- | --- |
| `consent`, `legal-claims`, `protection-of-rights`, `public-interest` | every restricted value, a restriction asked for or what a forgetting kept |
| `legal-obligation` | what a forgetting kept under a legal obligation, never a restriction a person asked for |

- A query reads restricted rows with `includeRestricted`: `app.queries.invoicesOf({ customerId },
  { includeRestricted: "legal-obligation" })`. The queries its handler composes read on the same
  basis unless they name their own. Its record says `restricted: { basis, persons, personCount }`,
  the restricted persons whose rows it read.
- A command runs on restricted data with `processRestricted`: `app.commands.correctAddress(payload,
  { processRestricted: "consent" })`. Its events carry the basis in `metadata.restrictionBasis`, and
  the access log records the restricted persons it read, as `operation: "command"`. It cannot be
  combined with `delay`: a basis holds when it is given.
- A policy or a process declares the basis it runs on: `export const restricted = "legal-claims";`
  in the policy's module, or in the process's `index.ts`. Its runs on restricted data go ahead, the
  commands it dispatches carry the basis as `processRestricted`, and each run that opened
  restricted data is recorded as `operation: "policy"` or `"process"`. An unknown basis fails the
  start with `ConfigurationError`.
- `deadLetters.list(args, { includeRestricted })`, `deadLetters.get(id, { includeRestricted })` and
  the same option of `subscriberFailures.list` and `get` open what a restriction keeps sealed.

A basis is not a check that the processing is lawful: it says, on the record, why the code that
names it believes it is.

### Lifting a restriction

Article 18(3) asks that the person be told before their restriction is lifted. `unrestrict` takes
how long before:

```ts
await app.unrestrict("c-42", { notice: "7d", ground: "accuracy-contested" });
```

With a duration, it appends `ProcessingRestrictionLiftAnnounced` to their stream, with the grounds
and categories it covers and `liftsAt`, and schedules the lift that long after, per ground and
category: a policy reacting to that event tells the person. Another announcement adds its own
lifts beside those. A `restrict` on the same ground before then cancels every lift announced on
it, and is appended even when the person is restricted on that ground already, since it is what
calls the lift off. When it comes due, the worker lifts what still matches, as whoever announced it. With
`notice: "given"`, for a person told already, it lifts at once. Without `ground` it lifts every
ground, and with `categories` only those categories of restrictions of categories; categories of a
person restricted as a whole on a ground it lifts are refused with `ValidationError`, as is a
notice missing or not positive.

A lift appends `ProcessingRestrictionLifted`, with the grounds and categories lifted and every
restriction the person still has, and schedules a run of the worker that retries, in order, every
`failed` dead letter the restriction caused, each as
[`app.deadLetters.retry`](/guides/dead-letters/#retrying-and-discarding) would, so the policies
run, the processes resume and the scheduled commands are dispatched, without an operator. A letter
that fails again for good stays `failed`, as that failure's letter, for the operator; one that
fails in a way worth retrying, a timeout or a store that does not answer, stays as it was and the
run is retried with the [retry settings](/reference/configuration/#retry) of policies; one refused
because the person is still restricted waits for the next lift. Nothing to lift appends nothing
and resolves without events.

The three events are the runtime's own: a read model may project them from
`projections/bounda/processing-restricted.ts`, `processing-restriction-lift-announced.ts` and
`processing-restriction-lifted.ts`, to show the person as restricted where customer service looks,
and a policy may react from `policies/bounda/<action>-on-processing-restricted.ts` and the others,
to tell the person; every [recipient](#recipients) that received data the change covers is told of
each of the three by the runtime (article 19). They are typed
`ProcessingRestrictedEvent`, `ProcessingRestrictionLiftAnnouncedEvent` and
`ProcessingRestrictionLiftedEvent`.

### Restrictions and restores

With a [forget ledger](#backups), every change of a person's restrictions is in it before it
commits, as a forgetting is: a restore of a copy taken before a restriction restricts the person
again, and one taken before a lift lifts them again, each change with its id and time, in order.
A change the ledger holds whose commit never happened is committed by the next reconciliation,
unless a later change of the person's restrictions is in the store. Without a ledger, `bounda
restored` and `restrict` again are how an operator puts them back.

### From the command line

```sh
bounda restrict c-42 --ground accuracy-contested --category contact
bounda unrestrict c-42 --notice 7d --ground accuracy-contested
```

See [the CLI reference](/reference/cli/#bounda-restrict).

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
unreadable. A person with any [restriction](#restricting-processing) is left alone while it lasts,
since keeping their data is what they asked for, and is forgotten once it is lifted if they are due
by then; a category's own retention leaves alone only the keys of a restricted category, or of a
person restricted as a whole.

No timer is armed per person. A subscriber of the dispatcher, `retention`, follows the stream from
its first event and records in `bounda_persons` when each person was last active and last
forgotten, with its own checkpoint, in batches, like any subscriber; it shows in the lag, and
started over from the first event it records the same rows. Every pass of the scheduled-command
worker then sweeps: an indexed read of the persons whose last activity is older than the
retention, not restricted and not forgotten since, a bounded batch of them each forgotten in a
transaction of its own. One instance sweeps at a time, under a lease kept in `bounda_checkpoints`
that the others leave alone until it lapses, two minutes after the holder last renewed it; an
instance that stalled past its lease stops at the next person, and the one that took it over goes
on. The deadline is worked out at sweep time from the setting, so changing it
applies at once, to everyone, and turning it on applies it to the history: whoever was already
inactive for that long is forgotten in the first passes. A person named by an event the subscriber has not recorded yet is
left for a later pass, read in the transaction that forgets them, so nobody is forgotten for an
activity the row does not show yet, nor twice when a lease changes hands mid-way; an event stored in
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

Policies and processes receive `forget(personId, options)` in their arguments, next to `commands`,
with the same `categories` a client's `forget` takes. It
forgets as `forget` on the app does, with `reason: "requested"`, inside the run's own unit of work:
the forgetting commits with the run's commands and its step, in the same transaction, or not at
all, so a run that fails and is retried forgets once. It resolves at once, before the commit, and
rejects an empty id with `ValidationError`. The `PersonalDataForgotten` it appends is caused by the
event the handler reacted to, one hop deeper, as its commands are.

### Each category for its own time

"Keep the invoices six years, the profile thirty days" is two [categories](#categories), each with
its retention. A declared category is forgotten on its own once the person has been inactive for
its retention, as `forget(person, { categories })` does, with `reason: "retention"` and `whole:
false`: the profile goes thirty days after their last activity, the invoices six years after it,
whatever the other categories do. A category whose basis is `legal-obligation` is forgotten that way
too when its retention ends, even when the app's retention forgot the person as a whole earlier:
that forgetting kept it, and its time runs from the activity it kept.

Activity is the person's, as for the app's retention: any event of the app's aggregates that names
them, whatever category it carries, so a customer who keeps ordering keeps their profile. The sweep
reads each category's keys by their last activity, recorded on every key the person holds in force
by the same subscriber, `retention`, which runs whenever the app has a retention or declares a
category; a key whose category is restricted, or whose person is as a whole, is left alone, and a key the sweep could not
forget waits on its own row, as a person does. `runtime.personalData.retention` is the default
category's retention, and forgets the person as a whole: every category but those a legal
obligation keeps, after which each declared category has nothing left to forget but what was
kept.

## The record of processing activities

Article 30 of the GDPR asks the controller to keep a record of what it processes: the categories
of personal data and of the persons they are about, the purposes, who receives the data and where,
how long it is kept and how it is protected. Most of that is in the app's modules and
configuration, so Bounda prints it:

```bash
bounda personal-data inventory
bounda personal-data inventory --json > record.json
bounda personal-data inventory --markdown > record-of-processing.md
```

It reads the registry and `bounda.config.ts`, as `bounda rebuild` loads them, and opens no
database. The record lists:

- each [category](#categories), with its basis and how long after the person's last activity it is
  kept, and how many fields are in it;
- each event, command, process state and read model with a field marked `personal` or `person`:
  whose the data is (the field marked `person`, else the aggregate's or the instance's id), each
  personal field with its category and how it is kept (sealed under the person's key, sealed with a
  [blind index](#sealed-at-rest), or [in the clear](#in-the-clear)), and where its copies go: the
  event store, the aggregate's [snapshots](/concepts/long-streams/#snapshots) when it takes them,
  scheduled commands and dead letters for a command, the read model's table, each in the database
  its adapter names;
- each [recipient](#recipients): its port, name, kind, country, the safeguard of a transfer out
  of the European Economic Area, and the categories it receives;
- what the runtime keeps about persons besides those fields: their keys, their activity and
  restrictions, its own events about them, [remembered answers](#remembered-answers) for as long as
  `runtime.commands.idempotencyKeyLifetime` keeps them, dead letters for as long as
  [`runtime.deadLetters.retention`](/guides/dead-letters/#keeping-resolved-letters) keeps resolved
  ones, what went to each recipient, the [forget ledger](#the-forget-ledger) for its `keepFor`, and
  the [access log](#who-opened-what) when `app/audit.ts` exists;
- whether a [master key](#a-master-key), a [tenant key store](#the-tenant-key-store) and a forget
  ledger are configured;
- the fields marked `notPersonal`.

What it cannot know is the controller's to add: who the controller, its representative and its
data protection officer are, the purposes in words beyond each category's basis, which categories
of persons each person id stands for, and the security measures outside the app. `--markdown`
writes the record as a document to complete with them.

The command also says what keeps the record from being complete, and exits `1` while anything does,
so a CI step fails on it:

- a field that can hold text and is [marked](#fields-that-hold-no-personal-data) neither
  `personal`, `person` nor `notPersonal`, which only a project that skipped the type check can
  have;
- a field of any type, marked none of them, whose name says personal data;
- text no mark reaches: a payload or a state that is not an object, or an object that keeps keys it
  does not declare, as `z.looseObject` and `.catchall()` do, which does not compile either;
- personal fields in the default category, which declares no legal basis: declare
  [categories](#categories) and give each field one;
- [`runtime.telemetry.errorText: "include"`](/reference/observability/#error-text), which puts the
  text of errors, personal data included, in logs no forgetting reaches.

A name says personal data when one of its words, or two of them joined, is one the GDPR's
definitions point at: an identifier of article 4(1), such as a name (`name`, `firstName`,
`surname`, `username`), contact (`email`, `phone`, `address`, `zip`), a birth date or an age, an
identity document or number (`passport`, `ssn`, `taxId`), money (`iban`, `card`, `salary`), an
online or device identifier (`ip`, `userAgent`, `cookie`, `deviceId`), a location (`latitude`,
`geo`), a trait (`gender`, `nationality`, `photo`, `signature`); a special category of article 9
(`health`, `religion`, `ethnicity`, `biometric`, `sexuality`) or a criminal record of article 10;
and free text written about someone (`note`, `comment`, `message`, `bio`). Words are read apart, so
`birthDate`, `birth_date` and `birthdate` all match, while `latency` never matches `lat`. A field the
list names wrongly, such as `welcomeEmailSentAt`, takes `notPersonal` like any other.

## Where the keys live

Each adapter keeps the keys in a table next to the events, `bounda_personal_keys`, one row per
key with the person, the category, the key, the id of the version of the tenant's key it is
wrapped under, its
fingerprint, the person's last activity and, for one a legal obligation kept past a forgetting,
since when: at most one key in force per person and category. Each key is named by the person and
its fingerprint: the memory adapter
in memory, SQLite and the Durable Object in their database, PostgreSQL in its schema. The
fingerprint is the key's AES-GCM tag of nothing under a nonce no value is ever sealed under, a key
check value: it names the key without revealing anything of it, and the runtime computes it from
the key itself, so it checks every key it reads against it, even one it can never export. Whether a person's processing is restricted, and since when, lives apart, in
`bounda_persons`, since a person without a key is restricted all the same, and so does, with a
retention, when they were last active and last forgotten as a whole. A key is created when the
first event with a personal field of that person in its category is stored, by the transaction
that stores it, and deleted by `forget`. Encryption is AES-256-GCM through WebCrypto, with a nonce per value, on Node and in
`workerd` alike; what the store holds for a personal field is an envelope with the ciphertext, the
person's id, the category unless it is the default one, and the key's fingerprint, which the [global stream](/guides/reading-the-stream/)
shows as it is; a value sealed under a key the person no longer has, because they were forgotten
and registered again, reads as `null` next to what their new key opens. What is read is opened by
that shape, whatever the schema marks, so an event or a delayed command whose handler or caller
writes an envelope itself, in any field, is refused with a `ValidationError`: it could only read
back as `null`, or not at all.

### Three keys deep

A key kept next to the data opens it for whoever reads the database: a dump, a backup, a replica,
a support session. So no key the database holds opens anything on its own. Every key stands in a
hierarchy, envelope encryption as a cloud KMS does it:

- the **master key**, which never enters the database nor the tenant key store: an environment
  variable, a Worker's secret, or a KMS;
- the **tenant's key**, one per tenant, wrapped under the master key and kept in a **tenant key
  store** apart from the tenant's database: another database, a KV namespace, a vault;
- the **persons' keys**, one per person and category, and the **database's key**, which derives
  the [blind indexes](#sealed-at-rest) and seals what the runtime keeps of
  several persons at once (a snapshot's state, a remembered answer that names nobody), all
  wrapped under the
  tenant's key and kept in the database;
- on an engine that encrypts its database files, libSQL's, **each file's key**, random, wrapped
  under the tenant's key and kept with it in the tenant key store, so the file itself opens only
  through the hierarchy (see [Encrypted database files](#encrypted-database-files)).

A copy of the database opens nothing without the tenant key store and the master key; a copy of
the tenant key store opens nothing without the master key. Destroying a person's key forgets the
person, in every copy; destroying the tenant's key [forgets the tenant](#forgetting-a-tenant), in
every copy too, which is what makes a backup or a Durable Object's point-in-time restore safe to
keep after a tenant leaves. The fingerprint of every key stays that of the key, whatever it is
wrapped under, so rotating any level rewrites wrappings and nothing else.

Every app has a tenant, and every tenant has its key, a single-tenant app as much as one of many:
the tenant is `default` unless something names another (see [Tenants](#tenants)).

### A master key

```ts
import { defineConfig, masterKey } from "@bounda-dev/core/config";
import { sqlite } from "@bounda-dev/sqlite";

export default defineConfig({
  storage: sqlite({ path: "./data/app.db" }),
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
      tenantKeys: sqlite({ path: "./keys/tenant-keys.db" }),
    },
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

An app whose registry marks a field `personal` needs both `keyWrapper` and `tenantKeys`: without
either it does not start, and the `ConfigurationError` says what to set. The one exception is
`memory()`, whose data goes with the process: it brings a master key WebCrypto generates and that
can never be exported, and a tenant key store in memory, both gone with the process too. A test app
over any adapter gets the same (see [In tests](#in-tests)).

A project from `create-bounda` comes with both: a master key generated for it in `.env` on Node, or
in `.dev.vars` on Cloudflare, both left out of Git, and a tenant key store where each runtime keeps
one (`./keys/tenant-keys.db` with SQLite, a second PostgreSQL database in `TENANT_KEYS_URL`, the
`TENANT_KEYS` KV namespace on Cloudflare). In production, set the variable the way the host keeps
secrets. On Cloudflare that is a secret of the Worker:

```sh
npx wrangler secret put BOUNDA_MASTER_KEY
```

Keep the master key and the tenant key store as you keep the database's backups, for as long as
they are kept: lost, either takes every person's data with it, as if each had been forgotten.
`bounda rebuild` reads the master key from `.env` like `boot()`; `rebuildReadModel` takes the
environment as `env`.

Every key exists in the app only as a WebCrypto key that can never be exported. WebCrypto
generates it, wraps it under the key above it and unwraps it straight into a key it seals and opens
with, so its raw bytes never reach JavaScript memory, where nothing could erase them: no string, no
buffer, on Node, in `workerd` or in a test app. The bytes read from the master key's variable are
zeroed once imported; the variable itself is the one copy the host keeps.

One key leaves WebCrypto, because its engine takes nothing else: an [encrypted database
file](#encrypted-database-files)'s key, which libSQL takes as text when it opens the file. The app
exports it at that moment alone, hands it straight to `@libsql/client` and keeps it in no variable,
log or error, zeroing the bytes it came from; libSQL holds it while the file is open, as any engine
that encrypts a file holds its key.

Unwrapped keys are kept in memory: the tenant's versions, and the persons' keys by fingerprint, up
to `UNWRAPPED_KEYS_KEPT` per app, each for `UNWRAPPED_KEY_TTL_MS` (five minutes) from the moment it
was unwrapped, so a command does not pay for unwrapping on every read, and the key of someone no
longer active does not stay usable in the process: keys past their time go at the next read of any
key, and a timer drops them when no key is read, without keeping a Node process alive. A Durable
Object arms no such timer, which would keep it from sleeping: there they go at the next read, or
with the object when the platform evicts it. A forgotten person's key goes once the forget commits,
and the keys the rotation unwraps are not kept. The person's row is still read first every time: a
person forgotten on another instance is forgotten here at once.

### The tenant key store

`runtime.personalData.tenantKeys` takes an adapter pointed at another database than the storage's,
which creates its table there (`bounda_tenant_keys`), or a store of your own from
`defineTenantKeyStore`; on Cloudflare, `kvTenantKeys({ binding })` keeps each tenant's record in a
KV namespace (see [Cloudflare](/adapters/cloudflare/#tenant-keys)). One store serves any number of
tenants, one record each, and an adapter that points at the storage's own database is refused at
the start: every copy of the database would carry the key that unlocks it.

```ts
import { defineConfig, masterKey } from "@bounda-dev/core/config";
import { postgresql } from "@bounda-dev/postgresql";

export default defineConfig({
  storage: postgresql({ url: process.env.DATABASE_URL }),
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
      tenantKeys: postgresql({ url: process.env.TENANT_KEYS_URL }),
    },
  },
});
```

Put it where the database's backups are not: another database whose backups are kept apart, or
apart for less time, another server, a managed KV or secret store. A store whose backups you keep
as long as the database's is still a second thing an attacker must get, but a tenant's forgetting
then reaches its copies only through the master key, which is in every one of them.

A tenant's record holds every version of its key, each wrapped under the master key with the
master key's id and the version's fingerprint, the random id of the database the key belongs to,
and, once the tenant is forgotten, when and under which event. A store written by several
instances compares the record's revision and writes it in one step, so two instances never put two
first versions in force; `defineTenantKeyStore` documents what a store of your own must do: get
and put a tenant's record, and list its tenants in pages, from a cursor, which a rotation of the
master key goes through. A store that cannot compare and set says `oneWriterPerTenant: true`, as
KV's does, and nothing but each tenant's own writer then rewraps a record there.

The database keeps its half of the binding in `bounda_tenancy`: the tenant it belongs to, the same
random id and when it was bound. An app that serves another tenant than the database's is refused,
and so is a database whose tenant's record belongs to another database, as two databases given the
same tenant name would be: give each database its own tenant, or its own store. A database that
lost its tenant's record while keeping keys wrapped under it is refused too, since starting afresh
would leave those keys unopenable; point `tenantKeys` at the store that holds it.

### Tenants

A tenant is a database with its own key: its events, read models and persons, nothing shared with
another tenant's. Which tenant an app serves depends on the host:

- In a **Durable Object**, the object is the tenant: its name, as `idFromName` gave it, or its id
  when it has none. Every tenant's key lives in one store, under that name.
- In **Node**, `boot({ tenant })`, `BOUNDA_TENANT`, or `--tenant` on the CLI names it; without any,
  the app serves `default`, and its ports receive no tenant. A project that serves several from one
  deployment exports its configuration as a function of the tenant, so each gets its own database:

  ```ts
  export default defineConfig(({ tenant }) => ({
    storage: postgresql({ url: process.env.DATABASE_URL, schema: `tenant_${tenant}` }),
    runtime: {
      personalData: {
        keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
        tenantKeys: postgresql({ url: process.env.TENANT_KEYS_URL }),
      },
    },
  }));
  ```

  `boot()`, the CLI and the React Router host call it with the tenant they serve; the React Router
  host boots one app per tenant its `app/tenant.ts` names (see
  [React Router](/guides/react-router/#tenants)). `configForTenant` gives the configuration of one
  tenant, for code of your own.

A tenant whose name changes is another tenant: its database is refused with the old name's record.

### Rotating the master key

Generate a new key, give it the variable the configuration reads, and move the old one to
`previous`:

```ts
keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY", previous: ["BOUNDA_MASTER_KEY_OLD"] }),
```

The master key wraps the tenant's key alone, so a rotation rewrites one record per tenant and
nothing in any database. Each running app rewraps its own tenant's record on the worker's next
pass, and `status` shows how many versions are left. A tenant whose app does not run, a Durable
Object that sleeps or a tenant no process serves, is reached from the tenant key store itself:

- In Node, `bounda tenant-key rewrap-master` rewraps every tenant the store holds, their apps
  running or not, over each record's revision, so it runs safely beside the apps. It exits with
  `2` while any tenant is left under a previous master key, naming each; `rewrapTenantKeys({
  config, env })` from `@bounda-dev/core` does the same in code, and
  `listTenantsUnderPreviousMaster` names those left.
- On Cloudflare each tenant's record is written by its own object alone, which KV needs: the
  `scheduled` of `createWorker` wakes every object still under a previous master key, which
  rewraps its own (see [Cloudflare](/adapters/cloudflare/#rotating-the-master-key)).

Each app logs once its own tenant's key is rewrapped:

```
this tenant's key is wrapped under the master key in force; remove the previous ones once bounda tenant-key rewrap-master, or the Worker's schedule, finds no tenant left under them
```

Whether another tenant is left is the store's to say: `bounda tenant-key rewrap-master` exits with
`0` only once none is, and on Cloudflare the schedule logs `bounda worker found no tenant left
under a previous master key`. Then remove the old variable and
`previous`. A tenant left under a key the wrapper no longer knows fails to start, saying which,
until the variable is given back.

Destroying the old master key once the backups of the tenant key store taken before the rotation
have expired is what makes those copies unreadable as a whole.

### Rotating the tenant's key

`rotateTenantKey()`, or `bounda tenant-key rotate`, puts a new version of the tenant's key in
force. New keys are wrapped under it at once; the worker rewraps every person's key and the
database's key under it in batches, on every pass, one instance at a time under a lease, and logs
once none is left under an older version:

```
no key is wrapped under an older version of the tenant's key any more; retire them
```

Then `retireTenantKeys()`, or `bounda tenant-key retire`, removes the older versions from the
record: a backup of the database whose keys are wrapped under them opens nothing personal any
more. It refuses while a key is still wrapped under one, and until twice `UNWRAPPED_KEY_TTL_MS`
after the version in force was created, since an instance that read the record before the rotation
wraps under the older version until it reads it again.

### Encrypted database files

In an app with a key wrapper and a tenant key store, `sqlite({ path })` encrypts its file under a
key of the tenant's own: a random key per file, wrapped under the tenant's key and kept in the
tenant's record. The file, its write-ahead log and every copy of them open only through the master
key and the tenant key store, so once the tenant is [forgotten](#forgetting-a-tenant) none of them
opens, its read models' columns [in the clear](#in-the-clear) included. `encrypt: false` keeps a
file in the clear; a libSQL server, such as Turso, encrypts by its own means and is left as it is.

The record keeps each file's key under the path the adapter is given, so keep the path as it is. A
file in the clear, or under an earlier key, is encrypted under the key in force, in place, when the
app starts with the file to itself. While another connection has it open, another process's or one
this process closed and libSQL has not let go of yet, it opens as it is and the app logs that it
left it so; from then on the worker tries again through the app's own connection every
`FILE_ENCRYPTION_RETRY_MS` (a minute) and encrypts it as soon as no other connection has it open,
as the next start does. Until then `app.status().files` and `bounda status` say which file is still
`"clear"` or under an `"earlier"` key, `bounda rekey` encrypts it once the other processes have let
go, exiting with `2` while one still holds it, and `forgetTenant` refuses while a file is in the
clear, since forgetting would leave it readable. A start that stops halfway leaves
`<file>.bounda-encrypting` beside the file, naming the key it was encrypting from: leave it, and the
next start opens the file under that key, which rolls back what was half written, and finishes. A copy restored under
another path opens under the key of the file it copies, and is encrypted under its own. A file in
the clear that another tenant's database is bound to is left as it is, and the start fails; so does
a new file whose tenant's record keeps another database's keys alone.

[Rotating the tenant's key](#rotating-the-tenants-key) gives each file a new key too: the app that
rotates moves the file under it as soon as no other connection holds the file, and the others
within `FILE_ENCRYPTION_RETRY_MS` or at their next start. Retiring the older versions destroys a
file's earlier keys only once the file is recorded under its new one, never before: a backup taken
earlier opens no more from then on.

Only what holds the keys opens such a file: the app; `bounda migrate`, `bounda forgotten` and
`bounda rebuild`, which read the master key from the environment as the app does; and a script of
yours through `withEncryptedFiles` from `@bounda-dev/core`, which runs on the configuration with
every file opened under the tenant's keys. A backup tool copies the file, and its `-wal`, as they
are.

### Upgrading from a version before tenant keys

A database written by a version of Bounda that wrapped the persons' keys under the master key, or
kept them as they were, opens as it is: the first start creates the tenant's key and binds the
database, and the worker rewraps every key under the tenant's, as a tenant key rotation does,
reading each raw key once, the only time a key's bytes reach JavaScript. The database's key of such
a version is replaced by one wrapped under the tenant's key, and the blind indexes are computed
again under it. The migration deletes the snapshots, whose states were kept in the clear, and the
answers remembered for rejections, whose messages may quote what a caller sent: the streams fold
from their events, and a command sent again after the upgrade runs again.

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
  runtime: {
    personalData: { keyWrapper: kms, tenantKeys: sqlite({ path: "./keys/tenant-keys.db" }) },
  },
});
```

`kid` is stored next to every version of the tenant's key the wrapper wraps; `unwrap` receives it
back, with what `wrap` returned. A KMS needs the key's raw bytes, so the tenant's key exists as bytes
while `wrap` and `unwrap` run, and only then: the runtime zeroes the array it gives `wrap` once it
settles, and imports what `unwrap` resolves as a key that can never be exported and zeroes that
array at once. So resolve a `Uint8Array` of your own, as the SDK hands it, and keep no copy of
either. The persons' keys never reach the KMS: the tenant's key wraps them inside WebCrypto. The
runtime checks the key `unwrap` answers against its fingerprint, so a wrapper that answers with
another key fails loudly instead of sealing data under it. KMS rotates a key's material itself and
keeps decrypting under the old one with the same ARN, so `kid` does not change; moving to another
KMS key is a rotation as above, with the old ARN in `previous`. Each instance asks KMS once for each
version of its tenant's key, and once more every five minutes while it runs.

A wrapper that fails, because KMS is unreachable, fails the command that needed the tenant's key,
which the caller or the reaction's retry sees; the person's data is not touched.

## Forgetting a tenant

When a customer of yours leaves, every person of theirs goes with them. `forgetTenant` destroys the
tenant's key, so nothing personal of the tenant opens again: not in the database, not in any of its
backups, not in a Durable Object's point-in-time restore.

```ts
await app.forgetTenant("acme");
```

The name must be the tenant the app serves: a `ValidationError` otherwise. While a person of the
tenant holds a key a legal obligation keeps (see [Categories](#categories)), it refuses, since that
data must stay: hand it back first, then pass `{ despiteLegalObligations: true }`. It resolves to
`{ tenant, forgottenAt, eventId }`; `bounda forget-tenant <tenant> --yes` does the same from a
terminal.

It runs in this order, every step safe to run again:

1. The tenant's record in the tenant key store loses every version of its key and records the
   forgetting, when and under which event id. This is the step that cannot be undone, and the only
   one needed: from here on nothing personal of the tenant opens anywhere.
2. The database marks the tenant forgotten, and `TenantForgotten` is appended to the stream
   `bounda:<tenant>`, with the categories the tenant's persons held keys of and the
   [recipients](#recipients) to tell.
3. Every person's key, the database's key, every snapshot and every remembered answer are deleted,
   and every read model's rows, but those of a read model whose view says it holds no personal data
   (`holdsPersonalData: false`): what another instance would still open with a key it keeps in
   memory, or a projection kept in the clear, is gone.

Once every recipient is told, its notice delivered or its dead letter resolved, what the engine
keeps beyond the tenant's key goes too: an [encrypted file](#encrypted-database-files)'s keys,
which the record kept under the master key so the notices could still read the file, are
destroyed, and the file and its copies open no more, the app running on an empty database in
memory; a Durable Object empties its storage. A PostgreSQL database stays, every read model's rows
deleted.

From then on the app serves nothing: every command, query, export and other call rejects with
`TenantForgottenError` (`TENANT_FORGOTTEN`), and a Worker from `createWorker` answers `410`. Another
instance sees it within `TENANT_CHECK_INTERVAL_MS` or at its first key it can no longer read, and
does the same. The worker only tells the recipients: each port that was disclosed data of any of the
tenant's persons, or may have been, gets its `onTenantForgotten`. An app that starts for a forgotten
tenant runs steps 2 and 3 again, so a forgetting cut short by a crash finishes, and a database
restored from a copy taken before it is forgotten again, `TenantForgotten` included, with the id
and time the record keeps.

What stays is what was never personal: the events' types, ids, streams and times, the ids of the
persons, and every field the registry does not mark `personal()`, as it is, since Bounda does not
know it describes anyone; personal fields stay as ciphertext no key opens. Mark everything that
describes a person, or a field kept in the clear stays readable after the tenant is gone. A read
model's rows go with the forgetting, but a backup of a read model's database taken before keeps
fields not marked `.personal()` in the clear until it is restored and an app starts on it (see
[Limitations](/reference/limitations/)). What your app does next is yours: delete the database once
nothing needs its skeleton, the tenant's Durable Object with `deleteAll()`, its PostgreSQL schema,
its SQLite file; the tenant key store keeps the record of the forgetting, which is what tells a
restored copy to forget again, so keep it at least as long as any backup of the tenant.

### Telling the recipients

A recipient's port module exports `onTenantForgotten`, beside its other handlers, and receives the
event and `persons()`, which lists in pages the ids of the persons whose data its port disclosed:
erase every one of them. With `presumed`, the port was declared after data existed, so it may
hold data no disclosure recorded, sent by a version of the port from before its declaration: erase
whatever it holds of the tenant, not only the persons listed.

```ts
export const onTenantForgotten = async ({ persons, mailer }: Port.OnTenantForgottenArgs) => {
  for await (const personId of persons()) await mailer.erase(personId);
};
```

The notice follows the rules of every other (see [Who is told, and how](#who-is-told-and-how)): retried
on failure, held in a dead letter when it gives up, which `retry` sends again even though the
tenant is forgotten.

## Backups

Restoring a copy of the database taken before someone was forgotten brings their key back, and
with it their data: the only record that they were forgotten was in the database the copy
replaced. The ICO's guidance for backups is to put them beyond use while they exist and, when one
is restored, to apply the erasures again. A forget ledger is how Bounda does the second part.

### The forget ledger

The ledger is a record of every forgetting kept outside the database: for each `PersonalDataForgotten`,
the person's id, the event's id, its time, its reason, the categories it asked for, `null` for
the person as a whole, and the fingerprints of the keys in force it covers, and nothing else. It is
a suppression list, the one thing about a forgotten person that has to outlive their data, so it
holds no field of theirs; a fingerprint is a check value of a key, which opens nothing and names
nothing once the key is gone. Forgetting someone again forgets what that forgetting asked for: a
withdrawn consent again, never the person as a whole, nor the invoices a legal obligation keeps,
and those kept again while their retention runs; a forgetting that only ended what an earlier one
kept asks for nothing, since the retention ends it again on its own. Every change of a person's
[restrictions](#restrictions-and-restores) and every [redaction](#correcting-a-persons-data) goes
to it too, with the events and fields asked for, ids and names alone. Give it a store a restore of
the database does not touch:

```ts
import { defineConfig, masterKey } from "@bounda-dev/core/config";
import { sqlite } from "@bounda-dev/sqlite";

export default defineConfig({
  storage: sqlite({ path: "./data/app.db" }),
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
      tenantKeys: sqlite({ path: "./keys/tenant-keys.db" }),
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
import { cloudflare, kvForgetLedger, kvTenantKeys } from "@bounda-dev/cloudflare";
import { defineConfig, masterKey } from "@bounda-dev/core/config";

export default defineConfig({
  storage: cloudflare(),
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
      tenantKeys: kvTenantKeys({ binding: "TENANT_KEYS" }),
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
time; its `readMark` and `raiseMark` keep numbers that only go up, which the runtime uses to tell
a copy [restored while the app was stopped](#restores); `forgetLedgerContract` from
`@bounda-dev/core/adapter/testing` is the test it has to pass.

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
forgetting still committing, which then commits with its own actor. After a restore the instances find, it
commits them at once: the copy cannot be committing any of them.

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
it. One instance takes each round, whichever finds it due first, and the time of the last round is
kept in the database, so a restore takes it back too and cannot hold the next round off. The
round runs on the worker's passes, in every instance whose role runs the worker; a Durable Object
runs it on the passes it wakes for, never waking for it alone, since restoring its storage
restarts it anyway. A database restored under a running app is reconciled at once, on the next
pass that [finds the restore](#restores).

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
the event store without starting the app; `bounda forget --from` commits again each forgetting
listed, of the categories it asked for or of the person as a whole, under its own id, time and
reason, as a reconciliation would: unless the database holds it, and only while the person holds a
key in force it covers and names. With a ledger configured, it records each in the ledger first. A
line may also be a bare person's id, for a list kept some other way, which is forgotten as a whole,
as a request, whenever the person holds a key: list only those forgotten after the copy was taken.
`--actor <id>` names who does it on each `PersonalDataForgotten` it appends.
`app.forgetAgain(entries, { actor })` is the same in code, each entry with its `categories`. Then
run `bounda restored`, so the jobs start over from the copy ([restores](#restores)). Without a
backup in play, `bounda forget <person>` forgets a person from the command line, `--category`
naming the categories alone, and `bounda export <person>` prints their data: see the
[CLI](/reference/cli/#bounda-export-and-bounda-forget-person).

Without either, a restored backup brings back the data of everyone forgotten after it was taken,
until they are forgotten again.

### Restores

A copy of the database brings back more than forgotten persons: the waits of the jobs that had
failed, which count failures against data the copy holds as it was. So the runtime finds a
restore, wherever it happens, and then:

- reconciles the forget ledger at once, without waiting for `reconcileEvery` or for a wait the copy
  brought back;
- has every instance forget what it knew of its background jobs, the backfill caught up, the
  rotation complete, the pauses after a failure, the dispatcher's backoff, and read the copy again;
- and, on the instance that found it first, clears the waits the copy brought back, on persons,
  keys, the backfill and the reconciliation.

The attempts of handlers, a policy's, a process's or a scheduled command's, stay as the copy has
them: those runs happened, and what they did through a port is not undone. Each find logs

```
the database went back to an earlier copy; background jobs start over
```

and `bounda status` counts the restores found. How it is found depends on when the copy came back:

| The copy was restored | Found by | What is guaranteed |
| --- | --- | --- |
| under the running app | every instance, on its next pass, before it delivers an event or claims a scheduled command, or within five seconds in the `web` role | Any copy taken before the last write the instances saw, or before the newest event an instance read or committed. A copy taken after both differs from the database in nothing but waits, which the jobs read again anyway. |
| while the app was stopped, with a forget ledger | the first instance to start, before it serves anything | Any copy taken before the last mark the ledger holds, which follows every move of the counter and a stop after any write, or before a forgetting the ledger holds and the copy does not. Only after a crash can a copy of the last five seconds of writes, with no forgetting among them, go unseen: it differs from the database in waits alone. |
| while the app was stopped, without a ledger | `bounda restored`, which you run after restoring | What you declare: the database alone cannot tell a copy from itself. |

Under the running app, every instance moves a counter in `bounda_checkpoints` one forward after
it wrote, at most every five seconds, and remembers what it read: a copy holds less, and the
first instance to see it counts the restore in another row, which every other instance then sees
changed. An idle instance writes nothing, so neither does its watch. Every instance also watches
the newest event it read, or committed as a forgetting, at its position: events are only ever
appended, so a copy that lost it is found at once, even one taken in the five seconds before the
counter moved. A pass that finds a restore reconciles the ledger before the dispatcher delivers
anything or the worker claims anything, so a scheduled command of someone the copy brought back
never runs. [Backups and restores](/guides/backups/) has the steps for each engine. With a forget ledger the
counter is also raised in the ledger, as a mark outside the database, which is how a start tells
a copy restored while the app was stopped; and a forgetting the ledger holds that the database
does not is a restore too, whatever the counter says, so the forgettings a copy undid are
applied again and found by the same reconciliation. A forgetting never depends on the mark: what
a restore that goes unseen leaves is waits, which end on their own within an hour.

On Workers KV, `kvForgetLedger`, a read may lag a write by up to a minute in another location, so
a start there may read an older mark and miss a copy of the last minute, unless a forgetting
tells it; with only one object per tenant writing it, the mark itself never goes down. A ledger
in a SQL database reads what was written. Without a ledger, run, after restoring:

```bash
bounda restored
```

`app.restored()` is the same in code. It counts the restore, so running instances learn of it
too, clears the waits, and reconciles the ledger at once when there is one.

### Old backups

The ledger handles a backup once it is restored. Rotating the [tenant's key](#rotating-the-tenants-key)
handles the others: retiring the older version once every backup it covers has expired leaves those
backups unreadable as a whole, the forgotten persons with everyone else. A tenant's backups need
nothing of the kind once the tenant is [forgotten](#forgetting-a-tenant): its key is gone, and with
it every copy.

## In tests

A test app needs no master key nor tenant key store: without them, `createTestApp` keeps keys of
its own in memory for each adapter it is given, the same for every test app over that adapter, so
one opens what another sealed. Tests that open one database through adapters of their own, as two
instances of the app would, pass the same `createTestKeys()` to each:

```ts
import { createTestApp, createTestKeys } from "@bounda-dev/core/testing";

const runtime = { personalData: createTestKeys() };
const first = await createTestApp({ registry, adapter: postgresql({ url }), config: { runtime } });
const second = await createTestApp({ registry, adapter: postgresql({ url }), config: { runtime } });
```

`createTestApp` forgets like any app, and `expectForgotten` checks that nothing of the person is
left readable:

```ts
import { createTestApp, expectForgotten } from "@bounda-dev/core/testing";

const { app } = await createTestApp({ registry });
await app.commands.registerCustomer({ customerId: "c-1", email: "ana@example.com", plan: "pro" });
await app.forget("c-1");
await app.runUntilIdle();
expect(await app.queries.getCustomer({ customerId: "c-1" })).toMatchObject({ email: null });
await expectForgotten(app, "c-1");
```

It looks for every value the person had: each value of a field marked `personal()` that the test
app sealed under a key they no longer hold, in an event, a process's state, a command it stored or
a dead letter, a cancelled command's included, and each value a read model kept in a field marked
`.personal()` for them before its category was forgotten. It searches every place the runtime keeps
something, read as stored, never through the APIs that open fields: every table of the storage
and of each read model's adapter, unmarked columns and JSON documents included, so a projection
that copied the email into a column it did not mark is found; the forget ledger; every entry
the app logged through the test app's `logger`; and every span it started, its attributes, status,
exceptions and events. A test app logs the text of errors so a failing
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
  - A read model kept the value: mark the field .personal(), which seals it under the person's key; for a field kept in the clear with .personal({ clear: true }), project PersonalDataForgotten and delete the row or clear the field.
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
await expectForgotten(app, "c-1", {
  values: ["Ana G.", "+34 600 123 456"],
  places: { mailer: mailer.sent },
});
```

- `values`: what a handler or a projection derived from the person's fields, a lowercased
  email or a formatted phone number, which no seal holds.
- `before`: the person's [export](#exporting-a-persons-data), taken before they were forgotten;
  every value it opened is looked for.
- `places`: anything else, under the name the report gives it: what a test double of a port was
  sent, so a test proves the [recipient's handler](#recipients) erased it there too.
- `categories`: the [categories](#categories) to check alone, after
  `forget(personId, { categories })`: what was sealed or kept of the person in them, and the
  fields of `before` in them, are looked for, and the person must hold no key in force of them.

Without `categories` it looks for what was sealed under every key the person no longer holds, so a
category a legal obligation kept past the forgetting, whose key they still hold, is left out: that
data stays lawfully, and its values may turn up anywhere it was kept. It refuses to pass for want
of something to look for: a person who still holds their keys, or one with no value to look for
and no `values`, rejects with an `Error` saying so, and so does one who still holds a key in force
of a category `categories` names.

Each app records the spans it starts for its own witness, beside the tracer provider registered
globally, which still receives every one, and without needing one: tests running in parallel see
none of each other's spans, and a provider the test registers, an SDK's included, is left as it is.

`expectRedacted` checks a [rectification](#correcting-a-persons-data): once fields of a person are
redacted, that what they held can be read nowhere.

```ts
import { createTestApp, expectRedacted } from "@bounda-dev/core/testing";

const [registered] = (await app.exportPersonalData("c-1")).events;
await app.redact("c-1", { events: [{ ...registered, fields: ["email"] }] });
await app.commands.correctEmail({ customerId: "c-1", email: "ana@new.example" });
await app.runUntilIdle();
await expectRedacted(app, "c-1");
```

It looks for every value the app's redactions of the person made unreadable, as each read
before, and the `values` the test adds, where `expectForgotten` looks, every table as stored, the
forget ledger, the logs and the spans, with the same rules and options for `values` and
`places`; and since the person still holds their keys, it also opens
every value stored sealed that a key still held opens, so the old value copied into another event,
a process's state, a command or a read model and left unredacted is found too. It rejects with
`NotRedactedError`, whose `found` holds `{ value, store, row, field }` for each, a sealed one's
field named with `(sealed)`, and whose message says what to do; and with an `Error` when it has
nothing to look for. Given an adapter instead of the app it searches that adapter's tables as
stored, for `values` alone. Either way it rejects while the worker has not settled a redaction of
the person, a `found` of `store` `"readModel"` naming the event types it reached: until then a read
model that projects one may hold a copy derived from the old value, a hash or a value reformatted,
that no search finds.

`expectRestricted` checks the other right a person may exercise, the restriction of their
processing: once they are restricted, that what the app hands out holds nothing the restriction
covers.

```ts
import { createTestApp, expectRestricted } from "@bounda-dev/core/testing";

await app.restrict("c-1", { ground: "accuracy-contested" });
await app.catchUpReadModels();
await expectRestricted(app, "c-1", {
  places: {
    "pro customers": await app.queries.customersOnPlan({ plan: "pro" }),
    "mailer": mailer.sent,
  },
});
```

It exports the person, and looks for the value of every field the export marks `restricted`, and
for the `values` the test adds, in the `places` the test passes, the results of its queries or
what a test double of a port was sent, and in the app's dead letters and subscriber failures as
`list` gives them. A value is matched as `expectForgotten` matches one. When it finds one, it
rejects with `NotRestrictedError`, whose `found` holds `{ value, place, field }` for each and whose
message says what to do. A person with no restriction, or none of whose values a restriction
covers, rejects with an `Error` saying so.

`expectTenantForgotten` checks a [tenant's forgetting](#forgetting-a-tenant): that the app refuses
every call, that its database holds no key, no snapshot and no remembered answer, that the tenant
key store holds no version of its key, and that no value of any of its persons turns up in the
clear wherever `expectForgotten` searches:

```ts
import { createTestApp, expectTenantForgotten } from "@bounda-dev/core/testing";

const { app } = await createTestApp({ registry, tenant: "acme" });
await app.commands.registerCustomer({ customerId: "c-1", email: "ana@example.com", plan: "pro" });
await app.runUntilIdle();
await app.forgetTenant("acme");
await expectTenantForgotten(app);
```

Given the app, it looks for every value of every person the app sealed or a read model kept,
and the `values` the test adds; given an adapter, such as one over a database restored from a copy,
it checks that adapter's tables for `values` alone. It rejects with `TenantNotForgottenError`, whose
`problems` list what is left beside values, and `found` the values, as `{ value, store, row,
field }`.

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

### An app built otherwise

An app built with `createApp` or `boot()`, those `createBounda` from `@bounda-dev/react-router`
boots, and a Durable Object take a witness instead of being test apps: `createWitness()` from
`@bounda-dev/core/testing` records what each app given it seals, keeps, logs and traces, as a test
app does for itself, so the expectations look for the same values in the same places, with nothing
passed by hand.

```ts
import { createApp } from "@bounda-dev/core";
import { createWitness, expectForgotten } from "@bounda-dev/core/testing";

const witness = createWitness();
const app = await createApp({ registry, config, witness });
await app.commands.registerCustomer({ customerId: "c-1", email: "ana@example.com", plan: "pro" });
await app.forget("c-1");
await app.runUntilIdle();
await expectForgotten(app, "c-1");
```

`boot({ witness })` takes it as `createApp` does, and logs what it logs itself through it;
`createBounda({ witness })` hands it to the boot of every app it serves, as `boot`'s `witness`, and
logs what a request throws through it. The expectations take the app, a client of it, or the
witness, which stands for every app it watches that has not stopped: pass the witness when the
host keeps the app to itself, as `createBounda` does. A witness that watches apps of several
tenants keeps each tenant's persons apart, since the same id names another person in another
tenant: each is looked for in its own tenant's tables, logs and spans, and `expectTenantForgotten`
checks the tenants one of whose apps refuses calls. `witness.logger(logger)` returns a logger
whose every entry is searched too, for what a host or a test logs beside the app. The text of
errors an app given a witness logs and traces is searched, since only its configuration made it
write it. An app given none records nothing and costs nothing; a witness is for tests alone, as it
keeps all it saw for as long as it is reachable.

A Durable Object runs its app in `workerd`, from the Worker's module, which a test does not build:
`witnessObjects` from `@bounda-dev/cloudflare/testing` gives the objects of a class it opens from
then on a witness, each object's persons apart, and the hosts it names, the Worker in front or
React Router's `createBounda` on Cloudflare, log through it too; the expectations take the object
inside `runInDurableObject` (see [Testing on Cloudflare](/adapters/cloudflare/#testing)).

`expectForgotten` also takes an adapter instead, and then searches that adapter's tables for
`values` and `before` alone: for a copy of a database restored from before the forgetting, or the
storage of an app given no witness. It reads the whole database, so point it only at a test's, and
call it before `app.stop()`: an in-memory database is gone once the app stops. It works on every
adapter: the in-memory one, SQLite, the Durable Object and PostgreSQL alike, each through its
`inspect()`. A SQLite file [encrypted under the tenant's key](#encrypted-database-files) opens only
through the adapter the app opened it with, `app.config.storage`.
