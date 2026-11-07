---
title: Personal data
description: Mark the fields of an event that hold personal data, say whose they are, forget a person or export their data with one call, forget them after a retention or when a purpose ends, wrap their keys under a master key kept out of the database, and handle forgetting in every read model that showed them.
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

A command scheduled before its fields were marked keeps its payload as it was written, in the
clear, and runs with it; `forget` cannot find it.

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
context of React Router. A client bound with `as` records who asked on `PersonalDataForgotten`, in
`metadata.actor`, and so on `ProcessingRestricted` and `ProcessingRestrictionLifted`. In one transaction it deletes the person's key, cancels the scheduled
commands that hold their data, removes the dead letters of those that gave up, and appends
`PersonalDataForgotten` to the stream `bounda:<personId>`: the runtime's own aggregate, `bounda`,
has one stream per person it forgot. Its payload is `{ personId, reason, cancelledCommands,
removedDeadLetters }`: `reason` is `"requested"` for `forget` and `"retention"` when the
[retention](#retention) forgot them, and the rest are the ids and types of what went, the only
record of commands that never became events. It resolves like a command, with the event's
position, so `catchUpReadModels({ through })` waits for the read models that handle it, and the Durable Object's `forget` and the one in React
Router's `bounda` context wait for them themselves unless `consistency` is `"eventual"`. A person
without a key is forgotten all the same, since a read model may hold what their events carried in
the clear, and forgetting twice appends twice. An empty id is refused with `ValidationError`.

From then on every personal field of theirs reads as `null`, in every event, however old. A
person registered again gets a fresh key; their old events stay unreadable. A command that loaded
their data before `forget` and appends after it never writes that data back, not even under the
fresh key another command gave them meanwhile: the state it loaded remembers the key each
person's data was read under, and an append that would seal their fields under any other fails
with [`ConcurrencyError`](/reference/errors/), as on a stream that moved. The retry decides on the
state without their data.

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
`null`; the stream's `ScheduledCommandFailed` and `ProcessFailed` name the error's class and code
and never its text, and so does the last error the inbox and the scheduler keep of a claim.

What `forget` does not reach is text your code writes elsewhere and data left unmarked: your logs
keep whatever you wrote to them, an event's payload written in the clear, with the data in a field
you did not mark, stays readable, a command's payload left unmarked is stored as it came, and the
error of work that names nobody, such as a process deadline or a scheduled command whose payload
marks nothing, stays in its dead letter in the clear. Log and throw with ids, not the data itself,
and mark every field that holds it.

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
}
```

`events` are every event that names the person, by its field marked `person` or its aggregate's
id, in position order, the events of their own stream `bounda:<personId>` included; `data` holds
the fields marked `personal` of that event, opened, and nothing else of its payload, so an event
without such fields has an empty `data`. `scheduledCommands` are the commands waiting to run
whose payload holds personal fields of theirs, with `commandId` the id the dispatch answered or,
for one the runtime scheduled itself, the scheduler's key, each with the same `data`.
`deadLetters` are the handler runs that gave up and name the person: work about them, whose
`errorMessage` and `errorStack` are encrypted with their key and come out opened, and the
scheduled commands whose payload holds their fields, with its `data`. After `forget`, the
person's events and letters are still theirs, and every field and error text reads as `null`, as
a handler reads it. An empty id is refused with `ValidationError`.

Only what is marked comes out, and that is the limit to know: a field left unmarked is not
personal data to Bounda, so the rest of `OrderPlaced` is the order's and stays out; a read model
is a view your code builds and may hold the person in any shape, and whatever a policy sent out
is at the mailing provider or the search index. An app that owes a person more than their marked
fields takes this export and adds what it knows from its read models and its ports. An event
stored before its type marked its fields names no one, so no export finds it: it holds the data
in the clear, where `forget` does not reach it either.

Each store keeps the person an event names in a `person` column, indexed with the position, and
the adapters read by it with `readByPerson`; a scheduled command is found by the `persons` it
carries, and a dead letter by its `person` or its `persons`.

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
commits has read the person as not restricted and may still store its events, as a command
running when `forget` comes may still decide on their data.

A policy, process or scheduled command whose command is refused this way becomes a dead letter at
once, as for any terminal error, with `errorCode: "PROCESSING_RESTRICTED"` and the person in
`person`, even when the event it handled names nobody: a policy on `Invited`, an event of the
newsletter, dispatching `registerCustomer` for the restricted customer. A failed process parks
what follows, as [it always does](/guides/dead-letters/#a-failed-process). Reading the person's
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
to an hour, while the pass goes on with the next ones; `nextDueAt()` names the end of that wait,
so a host never wakes for them again at once.

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
person with the key, the id of the key it is wrapped under and its fingerprint, a SHA-256 of the
raw key: the memory adapter in memory, SQLite and the Durable Object in their database, PostgreSQL
in its schema. Whether a person's processing is restricted, and since when, lives apart, in
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
fingerprint stays that of the raw key, so `forget` is still one transaction and nothing else
changes; a copy of the database without the master key opens nothing.

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

Unwrapped keys are kept in memory, by fingerprint, up to ten thousand per app, so a command does
not pay for unwrapping on every read. The person's row is still read first every time: a person
forgotten on another instance is forgotten here at once.

Without `keyWrapper` the keys are kept as they are, next to the data, and the app logs a warning
when it starts if the registry marks any field `personal`; an app from `createTestApp` warns
nothing. Setting one later wraps the keys kept so far in the background, as a rotation does.

### Rotating the master key

Generate a new key, give it the variable the configuration reads, and move the old one to
`previous`:

```ts
keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY", previous: ["BOUNDA_MASTER_KEY_OLD"] }),
```

A key wrapped under a previous master key still opens; the worker rewraps them under the current
one in batches, on every pass, as the retention sweep runs, and logs once when none is left:

```
no personal key is wrapped under a previous key any more; remove them
```

Then remove the old variable and `previous`. Rewrapping changes no event and no fingerprint, so it
runs while the app serves. A Durable Object wakes for it as for a deadline. An instance still on
the old configuration, in a rolling deploy, may wrap a new key under the old master key; the
worker finds it within a minute.

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
returned. The runtime checks what `unwrap` returns against the key's fingerprint, so a wrapper that
answers with another key fails loudly instead of sealing data under it. KMS rotates a key's
material itself and keeps decrypting under the old one with the same ARN, so `kid` does not
change; moving to another KMS key is a rotation as above, with the old ARN in `previous`. Each
instance asks KMS once per person it reads, thanks to the cache, and once per person it creates.

A wrapper that fails, because KMS is unreachable, fails the command that needed the key, which
the caller or the reaction's retry sees; the person's data is not touched.

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
After `forget`, an export reads the same way: the person's events, with nothing of theirs in them.

```ts
expect((await app.exportPersonalData("c-1")).events.map((event) => event.data)).toEqual([
  { email: null },
  {},
]);
```

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
