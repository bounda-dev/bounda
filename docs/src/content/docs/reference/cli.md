---
title: CLI
description: "The bounda command: generate the registry and the types, rebuild a read model, deal with dead letters, read the runtime's status, print the record of processing activities, list the recipients of personal data, forget a tenant and rotate its key, prune a forget ledger, migrate its tables and declare a restore."
sidebar:
  order: 0
---

`@bounda-dev/cli` installs the `bounda` command.

```bash
pnpm add -D @bounda-dev/cli typescript
```

TypeScript 7 or newer is an optional peer: the generator needs it only to infer the state of
aggregates without `state.ts`.

## Output

Every command prints its result on standard output and everything else on standard error: the
app's log lines, through Bounda's logger or straight to the console, the
[access log](/guides/personal-data/#who-opened-what) records, warnings, progress and errors.
Standard output carries nothing but the result, so `bounda dead-letters list --json` and
`bounda forgotten` pipe into another program as they are:

```bash
bounda dead-letters list --json | jq '.[].id'
```

The app's logger writes one line each, `[bounda] <level> <message> <fields as JSON>`, at `info` and
above.

## Error text

Standard error often ends up in a log, and the message of an error a handler throws may quote
personal data it read. So a command that fails on such an error prints its class and code, not its
message, and the app's log lines carry no error's text, as
[`runtime.telemetry.errorText`](/reference/observability/#error-text) says by default:

```
error: ValidationError (VALIDATION_FAILED); its message may quote personal data: run again with --error-text to print it
```

`--error-text`, on every command that loads the project, prints the message and lets the log lines
carry the text of errors for that run; `BOUNDA_ERROR_TEXT=include` in the environment or in `.env`,
or a configuration that sets `errorText: "include"`, does the same without it, and
`BOUNDA_ERROR_TEXT=omit` keeps the text out whatever the configuration says. What fails before any handler runs is printed in full: a configuration or a
registry that cannot be loaded, a read model that is not in the registry, a list `forget` cannot
read, and errors whose message Bounda writes from names and ids alone, such as a dead letter that is
not found or was already settled. To read what a reaction failed on, read its letter:
`bounda dead-letters list` opens the text it keeps encrypted, an access the access log records.
What a subscriber, a projection say, failed on last is in `bounda status --error-text`, recorded
the same way.

## Who runs a command

`--actor <id>` names who runs a command that acts or reads personal data: `rebuild`,
`dead-letters list`, `retry` and `discard`, `status`, `personal-data export` and `forget`. The command acts as that id, as
[`client.as(actor)`](/concepts/ids-causation-and-correlation/#who-acts) does in code: the events it
writes carry it in their metadata, its log lines name it, and so does every access log record it
causes.

```bash
bounda dead-letters retry 019a0c4e-3c9e-7a1b-9f1e-2b3c4d5e6f70 --actor ops-ana
bounda forget --from forgotten.jsonl --actor ops-ana
```

Give an id, such as the operator's account, never a name or an email: events keep it in the clear
and are never deleted. Without `--actor` the command names nobody, as before. An id that is not 1
to 255 characters is refused with exit code `1`. `bounda forgotten` takes none: it prints ids the
stream holds in the clear and records nothing, and `bounda generate` loads no app.

## Which tenant

`--tenant <name>`, on every command that loads the project, names the [tenant](/guides/personal-data/#tenants)
the app serves: a configuration that is a function of the tenant is called with it, and the app
opens that tenant's key. `BOUNDA_TENANT`, in the environment or in `.env`, does the same without it;
without either, the app serves `default`. Naming `default` is naming that same tenant: `bounda
export-tenant default` hands back, and `bounda forget-tenant default` forgets, what an app that
names no tenant wrote, its forget ledger included. An empty `--tenant` is refused.

```bash
bounda status --tenant acme
```

## `bounda generate`

Reads the project layout and writes `.bounda/registry.ts`, `.bounda/register.d.ts`,
`.bounda/types.ts` and one `+types/<name>.ts` next to every module. The registry carries, for every
aggregate, a `stateFingerprint` of the modules that shape its state and of the type inferred for
it, which its [snapshots](/concepts/long-streams/#what-a-snapshot-is-valid-for) are valid for.
Files whose content did not change are left alone; `+types` files whose module is gone are removed, and so are the folders
their removal empties; a folder holding nothing but `+types` (and Finder's `.DS_Store`) is not
taken for a module.

```bash
bounda generate
bounda generate --watch
bounda generate --root ./apps/shop --app-dir src --no-infer
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--root <dir>` | current directory | The project root: where `.bounda/` goes and `tsconfig.json` is looked for |
| `--app-dir <dir>` | `app` | The application directory under the root, with `domain/` and `read/` |
| `--tsconfig <file>` | `<root>/tsconfig.json` | The TypeScript project used to infer state |
| `--no-infer` | | Do not start TypeScript; aggregates without `state.ts` get `UnknownState` |
| `--watch` | | Regenerate after each burst of changes under the application directory |

Output lists every file written or removed, then a summary:

```
  written  .bounda/registry.ts
  written  app/domain/order/+types/order-placed.ts
1 aggregate, 1 read model, 10 files (2 written, 8 unchanged, 0 removed)
```

Warnings go to stderr and do not change the exit code. They come from a layout that is most likely
wrong without breaking a convention (see
[what the generator warns about](/reference/conventions/#what-the-generator-warns-about)) and from
state inference:

```
warning: order: field "cancellation" (set by orderCancelled) has a type that is not visible
from .bounda/types.ts (Cannot find name 'Cancellation'.); it is typed as unknown. Export the type
or add state.ts
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Generated, possibly with warnings |
| `1` | The layout breaks a convention. Every problem is listed with its path; nothing is written |
| `2` | Something else failed, such as a file where `.bounda/` should be |

### Watch mode

`--watch` regenerates after each burst of changes, 100 ms after the last one, and ignores changes
to `+types` and `.bounda` directories. It makes its first run only once it is listening, so a module saved while
that run is going is regenerated right after it, and prints `watching app/ for changes` once that
run has succeeded, on standard error. To know it is listening, it writes a file named `.bounda-watch-<uuid>` into
the application directory until it sees the change come back, then removes it: the file system can
start listening a moment after it is asked to, and miss what changes before. When it has not seen
it after 20 tries, a second, it prints a warning that watching may miss changes, removes the file
and goes on. A run that fails prints its problems and watching goes on; a first run that fails
outright, such as a file where `.bounda/` should be, ends it. `Ctrl-C` ends it too.

### How state is inferred

For an aggregate without `state.ts`, the generator writes a first pass in which the state is
`UnknownState`, opens the project with TypeScript, reads the return type of every event's
`begin` and `evolve` and unions the fields it finds. The fields every `begin` always sets are
required once the aggregate exists, and a command handler sees that state or the one of an
aggregate that does not exist yet, every field `undefined`:

```ts
export type OrderCreatedState = {
  readonly customerId: string;
  readonly lines: readonly import("../app/domain/order/order-placed.ts").Line[];
  readonly paidWith?: "card" | "transfer";
  readonly status: "cancelled" | "paid" | "placed";
};
export type OrderState = core.NotCreated<OrderCreatedState> | OrderCreatedState;
```

`evolve` gets `OrderCreatedState`. Without any `begin`, there is only `OrderState`, every field
optional, since any event could come first.

A field an `evolve` computes from the state, such as `reminders: state.reminders + 1`, has no type
in that first pass. The generator reads every `evolve` again against the state it has inferred so
far, until nothing changes, so the field takes the type the other events give it. One that only
ever comes from itself, with no `begin` or other event to give it a type, becomes `unknown`, and a
warning names it: set it in a `begin`, or add `state.ts`. So does a chain of fields computed one
from another that has not settled after a few passes. A field that is `any` on purpose, set from
`JSON.parse` or a `z.any()` payload, stays as it is.

Types exported from your modules are referenced through `import(...)`. A type that is not
exported cannot be named from `.bounda/types.ts`; that field becomes `unknown` and a warning says
which field and which events set it. Export the type, or add `state.ts`, to fix it. Without
TypeScript installed, or when it cannot open the project, the state stays `UnknownState` and the
warning says so.

## `bounda rebuild`

Rebuilds one read model from the whole global stream without taking it offline. It loads
`bounda.config.ts` and the generated registry the way `boot()` does, so it runs from the project
root with the same environment as the app.

```bash
bounda rebuild orderSummary
bounda rebuild orderSummary --root ./apps/shop --config bounda.config.ts --registry .bounda/registry.ts
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--root <dir>` | current directory | The project root, where the configuration and `.bounda/` are |
| `--config <file>` | `bounda.config.ts` | The configuration module under the root |
| `--registry <file>` | `.bounda/registry.ts` | The generated registry module under the root |
| `--actor <id>` | | Who runs it, named in its log lines; see [who runs a command](#who-runs-a-command) |
| `--error-text` | | Print the message of the error it fails on, and log the text of errors; see [error text](#error-text) |

The projections run into a fresh table that takes the live table's place once it has caught up;
an interrupted rebuild resumes where it stopped, and a second one started meanwhile takes over.
[Rebuilding a read model](/guides/deployment/#rebuilding-a-read-model) says how it works and when
to run it in a deploy.

```
rebuilt read model "orderSummary": 48213 events, checkpoint at position 48213
```

Use it after fixing a projection, and when a view loses a field or changes a field's type, which the
app refuses to do on start. Exit codes: `0` rebuilt, `1` bad arguments, `2` the project could not be
loaded, the read model is not in the registry, or a projection failed.

## `bounda dead-letters`

Lists, retries or discards the handler runs that gave up. It boots the project the way `boot()`
does, without starting the background work, so it runs from the project root with the app's
environment.

```bash
bounda dead-letters list
bounda dead-letters list --kind policy --handler order.notifyOnOrderPlaced
bounda dead-letters list --status retried --limit 20 --json
bounda dead-letters retry <id>
bounda dead-letters discard <id>
```

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--kind <kind>` | `list` | `policy`, `process`, `scheduled` or `recipient` |
| `--status <status>` | `list` | `failed` (default), `retried` or `discarded` |
| `--handler <name>` | `list` | The policy or process name as the letter records it, e.g. `order.notifyOnOrderPlaced`, the scheduled command's type, e.g. `PlaceOrder`, or the port of a [recipient](/guides/personal-data/#recipients), e.g. `customer.mailer` |
| `--limit <n>` | `list` | At most this many letters: a whole number, 0 or more |
| `--json` | `list` | Print the letters as JSON |
| `--root`, `--config`, `--registry`, `--error-text` | all | As for `bounda rebuild` |
| `--actor <id>` | all | Who lists, retries or discards: named in the access log record each one writes, in the events a retry writes and in the log line of a retry or discard |

```
019a0c4e-3c9e-7a1b-9f1e-2b3c4d5e6f70  failed  policy  order.notifyOnOrderPlaced
    OrderPlaced on order:o-1, 1 attempt, last 2026-09-22T14:03:11.402Z (terminal)
    ValidationError (VALIDATION_FAILED): mail server rejects it
019a0c51-8d2f-7c4e-a1b2-3c4d5e6f7a80  failed  process  order.orderPayment
    OrderPaid on order:o-2, 3 attempts, last 2026-09-22T14:05:40.118Z (retriable_exhausted)
    Error: payment provider timed out
    2 events are parked behind it; retrying it handles them in order
2 dead letters
```

A letter retried or discarded shows when after its status (`retried 2026-09-23T08:00:00.000Z`).
The third line of each letter is the error's class, its code when it is one of
[Bounda's](/reference/errors/), and its message. The message is kept encrypted with the key of
the person the work names, so it is left out once that person was
[forgotten](/guides/personal-data/); see [what a letter holds](/guides/dead-letters/#what-a-letter-holds).

When `retry` fails, because the handler fails again or the letter cannot be retried or was settled
first, the error is printed, as [error text](#error-text) says, and the exit code is `2`. For a
process letter it also says when one of the parked events failed the process again. What a retry runs for each kind is in
[Dead letters](/guides/dead-letters/).

## `bounda status`

Prints where the runtime's background work stands, as the database says. It boots the project as
`bounda dead-letters` does.

```bash
bounda status
bounda status --json
bounda status --error-text --actor ops-ana
```

```
tables
  storage  storage  3 of 3
  storage  checkpoints  1 of 1
  forgetLedger  forget-ledger  4 of 4
restores found while running: 0
subscribers (head at 1204)
  projection:customerDirectory  at 1197, 7 behind
    failing: Error on CustomerRegistered at 1198, 4 attempts since 2026-11-09T10:02:11.000Z
  policies  at 1204, 0 behind
personal data backfill: sealed through position 1204, caught up
forget ledger: reconciled, applied through 2026-11-08T22:15:00.000Z, last run 2026-11-09T10:00:00.000Z
tenant: acme, key 7Kx0Qw9zR2bV1mPq (older Wn3eT1aaK8sL0dXy), wrapped under master key c1Hq4Z0aJ5fM
database files
  storage  ./data/acme.db  encrypted under the tenant's key in force
key rotation: under 7Kx0Qw9zR2bV1mPq (previous Wn3eT1aaK8sL0dXy), 12 keys left to rewrap
retention
  default  2y, 0 persons past it, next due 2028-01-04T09:13:00.000Z
  marketing  18mo, 3 keys past it, next due 2026-11-09T11:40:00.000Z
  invoices  6y, 0 keys past it, next due 2031-02-12T16:20:00.000Z
dead letter retention: 30d, next purge 2026-11-20T08:00:00.000Z
subscriber failure retention: 30d, next purge when a failure is resolved
recipients
  customer.mailer  Mailchimp, processor, US, transferred to US under standard-contractual-clauses (article 46(2)(c)): contact; 812 persons disclosed to it
    2 notices failed: bounda dead-letters list --kind recipient --handler customer.mailer
```

- `tables`: each scope of Bounda's tables, in each database the configuration names (`storage`,
  `readModels.<name>` for read models in a database of their own, `forgetLedger`), at the version
  the database holds of the one this release migrates it to; one behind says
  `(migrations pending: bounda migrate)`. A store without tables, as `memory()`, has none.
- `restores found while running`: how many times a running instance found the database gone back
  to an earlier copy ([restores](/guides/personal-data/#restores)), or declared by `bounda restored`;
  with a forget ledger, every one found, those on a copy a later restore took back included.
- each subscriber's checkpoint and lag, and its last failure, by any instance: `failing` while it is
  still stuck on it, `last failed, resolved …` once it got past. Its class and code, the event, how
  many deliveries in a row failed and since when; never its text. A subscriber the app no longer
  runs follows, `no longer run`, while the store keeps its failure, until the
  [failure retention](/reference/configuration/#subscriber-failures) removes it.
- the [tenant](/guides/personal-data/#tenants): the version of its key in force, the older ones
  its record still holds, and the master key they are wrapped under, or how many versions are left
  to [rewrap](/guides/personal-data/#rotating-the-master-key) under it; `forgotten at …` once it
  is [forgotten](/guides/personal-data/#forgetting-a-tenant), followed by a `forgotten tenant` line:
  whether every recipient was told, whether the forget ledger holds nothing of the tenant any more,
  whether the keys of its [encrypted files](/guides/personal-data/#encrypted-database-files) are
  destroyed, and `the database may be deleted` once all are (with no ledger, the other two),
  `keep the database` until then; while it is [frozen](/guides/personal-data/#freezing-a-tenant),
  a `frozen tenant` line: since when, and whether every store is, or `run bounda freeze-tenant
  again` for a freeze cut short.
- each database file [encrypted under the tenant's key](/guides/personal-data/#encrypted-database-files),
  and where it stands: `still in the clear` or `still under an earlier key` while another connection
  kept it from being encrypted, which [`bounda rekey`](#bounda-rekey) does once it can.
- the [backfill](/guides/personal-data/#marking-a-field-later) of personal data, the forget
  ledger's [reconciliation](/guides/personal-data/#what-the-runtime-does-with-it), the
  [rotation](/guides/personal-data/#rotating-the-tenants-key) of the tenant's key, followed, once
  the tenant's data was [resealed](/guides/personal-data/#recovering-from-a-full-compromise), by a
  `reseal` line with the step under way, since when and how many old keys it still keeps, or
  `complete` and when; the
  [retention](/guides/personal-data/#inactivity), `not configured` when it is off, and the
  purges of [resolved dead letters](/guides/dead-letters/#keeping-resolved-letters) and of
  [subscriber failures](/reference/configuration/#subscriber-failures), each with how many past it
  are kept while a person whose data they hold is restricted, the first with the failed letters of
  a handler the app no longer runs, which wait for an operator to discard them, and each saying so
  when its store could not be read, the reason in the logs.
  The retention has a line for the app's, which forgets persons as a whole, under `default`, and
  one for each category of `app/personal-data.ts`, which [forgets its
  keys](/guides/personal-data/#each-category-for-its-own-time), with how many are past it now and
  when the next comes due, and the keys a forgetting kept that no erasure exemption keeps any more.
- every [recipient](/guides/personal-data/#recipients), as [`bounda recipients`](#bounda-recipients)
  prints them.

A part whose store cannot be read does not stop the others: it is logged, its line says
`its store could not be read, see the logs` where the value would be, and the rest is printed as
usual. A database of `tables` and a subscriber's checkpoint each count as a part of their own, so a
read model's database that is down costs only its own lines; without the head of the stream,
`subscribers: where they stand, …` lists each last failure under its subscriber instead, as
`failed, not resolved` when it may still hold the subscriber back. `--json` prints such a part as
`{ "unreadable": true }`, with `retentionMs` for a purge, `database` for an entry of `schema`, and
`subscriber`, and `failing` when this process saw it fail, for one of `lag.subscribers`. With
`--error-text`, the failures' text is not read when their store could not be. stderr then names
every part it could not read, as `unreadableParts` from `@bounda-dev/core` names them:

```
error: could not read lag (projection:customerDirectory), subscriberFailures; see the logs
```

Under the rule of [error text](#error-text) set to `"include"`, by `--error-text`,
`BOUNDA_ERROR_TEXT=include` or the configuration, it also prints, under each failure, the text it
keeps, encrypted under the person the event names: it is read through `app.subscriberFailures.list()`, which records it in the
[access log](/guides/personal-data/#who-opened-what) with the persons and `--actor`. A failure whose
person was forgotten says its text went with them.

| Option | Meaning |
| --- | --- |
| `--json` | Print `app.status()` as JSON; with `--error-text`, `subscriberFailures` holds the failures with their text |
| `--root`, `--config`, `--registry`, `--error-text` | As for `bounda rebuild` |
| `--actor <id>` | Who reads the failures' text with `--error-text`, named in the access log |

Exit codes: `0` every part read, `1` bad arguments, `2` the project could not be loaded, or a part
of the status, or the failures' text asked for, could not be read. A check that runs
`bounda status` alerts on a store that is down, as it did when nothing could be read, and still
has the rest printed.

## `bounda restore`

Puts a copy of the storage's SQLite file back in place, with the app running or not: in one write
transaction through libSQL, the app's own engine, so a running app reads the database as it was or
as the copy has it, never in between. The restore is counted in the same transaction, once: every
running instance finds it at its next pass, and a stopped app when it starts, with a forget ledger
or without one, so no `bounda restored` follows it. It loads the
configuration as `bounda migrate` does, and opens a file encrypted under the tenant's keys, and its
copy, through them.

```bash
bounda restore /backups/app.db
```

```
restored /backups/app.db in place, in one transaction: running instances find the restore at their next pass, and a stopped app when it starts
```

Every table, index and trigger becomes the copy's, Bounda's tables brought to the versions the
database held. A copy that is missing, does not open, is another tenant's, or that a newer version
of Bounda migrated is refused, and nothing changes. A
storage on another engine is refused: restore it with the engine's tools, as
[Backups and restores](/guides/backups/#restoring) says. Options: `--root`, `--config`,
`--registry`, `--tenant`, `--error-text`, as for `bounda rebuild`. Exit codes: `0` restored, `2`
refused or the project could not be loaded.

## `bounda restored`

Says the database was restored from a copy while the app was stopped, for an app without a
[forget ledger](/guides/personal-data/#backups), whose mark tells it on its own. It boots the
project as `bounda dead-letters` does.

```bash
bounda restored
```

```
restore recorded: 1 found so far; the background jobs start over from the copy, without the holds it brought back
```

The restore is counted, so every running instance starts its background jobs over; the holds of
failures the copy brought back are cleared; and with a ledger, it is reconciled at once. A
restore is counted once: run again after it failed, it finishes the same declaration (once the
database was written to, it counts another). With a ledger whose mark it cannot raise, it fails
having counted nothing. While the database stands exactly where handling the last restore left
it, as after it ran already or after a start or `bounda restore` counted the restore, it counts
nothing and says so:

```
nothing counted: the database stands exactly where handling the last restore left it, as when this already ran or a start found that restore; if it was restored from a copy taken right then, run bounda restored --again
```

A copy taken at that very moment is the same database, and the ledger cannot tell it either until
the instances move their counter: if that is the copy you restored, `--again` counts it. Run it
after `bounda forget --from` when restoring without a ledger (see
[restores](/guides/personal-data/#restores)). Options: `--again`, and `--root`, `--config`,
`--registry`, `--error-text`, as for `bounda rebuild`. Exit codes: `0` recorded, or nothing to
count, even when how many restores were found could not be read back, which it says in place of
the count; `2` the project could not be loaded.

## `bounda rekey`

Encrypts under the tenant's key in force every [encrypted database
file](/guides/personal-data/#encrypted-database-files) still in the clear or under an earlier key,
which a start leaves so while another connection holds the file, and prints where each stands:

```bash
bounda rekey --tenant acme
```

```
database files
  storage  ./data/acme.db  encrypted under the tenant's key in force
```

It reads only the configuration, with the master key from the environment, and starts no app; run
it once the other processes that hold the file have stopped. Exit codes: `0` every file under the
key in force, `2` one still held elsewhere, or the project could not be loaded.

| Option | Meaning |
| --- | --- |
| `--root`, `--config` | As for `bounda migrate` |
| `--tenant <name>` | The tenant whose files to encrypt, for a configuration of the tenant (default: `BOUNDA_TENANT`) |

## `bounda migrate`

Brings Bounda's tables to this release's version in every database the configuration names, as
the first instance to start would, and prints the versions after:

```bash
bounda migrate
```

```
migrated
  storage  storage  3 of 3
  storage  checkpoints  1 of 1
  readModels.reports  checkpoints  1 of 1
```

It reads only the configuration, never the registry, and starts no app: run it as a step of the
deploy, after stopping the previous version and before starting the new one (see
[Schema](/guides/deployment/#schema)). Each database migrates under its own lock, as a start does,
so running it twice, or while an instance starts, migrates once. Tables a newer release migrated
are refused untouched with [`STORAGE_SCHEMA_TOO_NEW`](/reference/errors/#codes). A SQLite file
[encrypted under the tenant's key](/guides/personal-data/#encrypted-database-files) opens under the
keys of the tenant `--tenant` names, with the master key read from the environment, and one in the
clear is encrypted first, as a start would; `bounda forgotten` and `bounda rebuild` open it the same
way.

| Option | Meaning |
| --- | --- |
| `--root <dir>` | The project root, the current directory by default |
| `--config <file>` | The configuration module under the root, `bounda.config.ts` by default |
| `--tenant <name>` | The tenant whose databases to migrate, for a configuration that is a function of the tenant; `BOUNDA_TENANT` by default |

Exit codes: `0` migrated, `1` bad arguments, `2` the configuration could not be loaded or a
migration failed.

## `bounda personal-data export` and `bounda forget <person>`

Answer a person's request from the command line. Both boot the project as `bounda dead-letters`
does, and act as `--actor`.

```bash
bounda personal-data export c-42 --actor ops-ana --output c-42.json
bounda personal-data export c-42 --actor ops-ana | jq '.events | length'
bounda forget c-42 --category marketing --actor ops-ana
bounda forget c-42 --category census --objection --actor ops-ana
bounda forget c-42 --actor ops-ana
```

`bounda personal-data export <person>` writes, as JSON, what `app.exportPersonalData` answers: every
record that names the person, with each field's category, every category's basis, special categories
of data and criminal data, purposes, sources, retention and exemptions from erasure, and the
person's rights (see [Exporting
a person's data](/guides/personal-data/#exporting-a-persons-data)). It streams it, reading and
writing a page of records at a time, however long the person's history, and reads no faster than its
output takes it. It prints to standard output; with `--output <file>` it writes the file instead,
readable by its owner alone, beside it as `<file>.partial` until the export is whole, then moved
into place, so a failed export leaves no file. An export that fails once it started printing, as
when the person is forgotten, restricted or redacted meanwhile (`CONCURRENCY_CONFLICT`), has printed
a document cut short, which is not valid JSON, and exits `2`: run it again. It is recorded in the
access log like any export. Text that may quote someone else's data is [held
back](/guides/personal-data/#someone-elses-data) as article 15(4) asks; `--include-withheld` opens
it, still marked, for the controller to weigh before handing the export over, recorded so in the
access log.

`bounda forget <person>` forgets the person as a whole, as `app.forget` does, and prints
`forgot c-42`; with `--category`, repeated for several, only those categories, as when a consent is
withdrawn, and prints `forgot marketing of c-42`. A category an [exemption of article
17(3)](/guides/personal-data/#categories) keeps is kept, restricted, until its retention ends,
either way. With `--objection`, after an objection the app upheld, it forgets as `forget` with
`objection` does, keeping of what the objection reaches only what a legal obligation or legal claims
keep (see [After an objection](/guides/personal-data/#after-an-objection)), and adds `after their
objection` to what it prints. A category the app does not have fails with
`VALIDATION_FAILED` and nothing is forgotten. The export lists the person's restrictions, and marks
on each record the fields a restriction covers.

## `bounda personal-data inventory`

Prints the record of processing activities of article 30 of the GDPR, as far as the modules and the
configuration say it: the categories of personal data with their basis, the special categories of
data and the criminal data they hold, with their condition or authority, their purposes, those the
GDPR has rules for, their sources, the ports whose calls return their data, their retention and the
exemptions of article 17(3) that keep them past erasure, the automated decisions, with the special data they decide on and their measures, every
event, command, process state and read model that holds personal data, whose and where, every
recipient, what the runtime keeps about persons and for how long, and the fields marked
`notPersonal`. It loads the project as `bounda rebuild` does and opens no database; in a Cloudflare
project it reads modules that import the Workers runtime, without running them. Where each holder
and record is kept names the database's adapter, and the jurisdiction it keeps the data in when it
declares one, such as `postgresql, in eu`, or `cloudflare, in eu` for [Durable Objects in the
EU](/adapters/cloudflare/#data-location), and the transfer of one kept out of `storage`'s
jurisdiction, by the legal regime it goes to, its safeguard and the safeguard's article, `tenant-keys, in fedramp,
transferred to US under binding-corporate-rules (article 47)`; each recipient out of the European
Economic Area says the same, `Mailchimp, processor in US, transferred to US under
standard-contractual-clauses (article 46(2)(c))`: see [data
location](/reference/configuration/#data-location) and [stores in another
jurisdiction](/reference/configuration/#stores-in-another-jurisdiction). See [The record of processing
activities](/guides/personal-data/#the-record-of-processing-activities).

```bash
bounda personal-data inventory
bounda personal-data inventory --json
bounda personal-data inventory --markdown > record-of-processing.md
```

```
Personal data inventory (GDPR article 30)

Categories
  default  no basis declared  kept until forgotten  0 fields
    for: no purpose declared
    from: no source declared
  account  contract  forgotten 2y after last activity  14 fields
    for: Run the user's account
    from: the person
  newsletter  consent  forgotten 2y after last activity  1 field
    for: Send the newsletter they signed up for
    from: the person
    processed for: direct-marketing
  invoices  legal-obligation  forgotten 6y after last activity  3 fields
    for: Keep the invoices tax law requires
    from: the person
    kept past erasure: legal-obligation (article 17(3)(b))

Automated decisions
  none declared

Personal data
  event user.UserRegistered, of the aggregate's id
    email  account  sealed under the person's key
    name  account  sealed under the person's key
    kept in: event store (sqlite, in eu)
  read model usersDirectory, of the person in userId
    email  account  sealed under the person's key, found by a blind index
    name  account  sealed under the person's key
    kept in: read-model table (sqlite, in eu)
…
Complete: every field is classified
```

The record ends with what keeps it from being complete, one finding a line: a field that can hold
text and is marked neither `personal`, `person` nor `notPersonal`, a field whose name says personal
data and is not marked, a personal field whose name says special categories of data or criminal data
in a category that does not declare them, text no mark reaches, personal fields in the default
category, which declares no legal basis, logs that carry the text of errors, and a store of
personal data that declares no location, so the record cannot say whether it is a transfer.

| Option | Meaning |
| --- | --- |
| `--json` | Print the record as JSON, as `personalDataInventory` from `@bounda-dev/core` returns it |
| `--markdown` | Print it as a Markdown document, for the controller to complete and keep |
| `--root`, `--config`, `--registry`, `--tenant` | As for `bounda rebuild` |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The record is complete |
| `1` | It has findings, printed with it; or the command line is wrong |
| `2` | The project failed to load, or its configuration is one the app refuses to start on, such as a read model kept in another [location](/reference/configuration/#data-location) than `storage` without a safeguard |

## `bounda recipients`

Lists the recipients of personal data: every port that declares one, and every one the store
remembers data went to. With a person, prints as JSON what `app.recipientsOf` answers, the
recipients of their data as they may ask for them (article 19); it is recorded in the access log,
as `recipientsOf`, with `--actor`. It boots the project as `bounda dead-letters` does.

```bash
bounda recipients
bounda recipients --json
bounda recipients c-42 --actor ops-ana
```

```
recipients
  customer.crm  Brevo, third-party, FR: contact, invoices; 37 persons disclosed to it
    being told what was recorded before it was declared
  customer.mailer  Mailchimp, processor, US, transferred to US under standard-contractual-clauses (article 46(2)(c)): contact; 812 persons disclosed to it
    2 notices failed: bounda dead-letters list --kind recipient --handler customer.mailer
  order.sms  no longer declared, 4 persons disclosed to it
```

Each line names the port, its recipient as the port declares it now, with its kind, country, the
transfer out of the European Economic Area, by the legal regime it goes to, its safeguard and the
article it rests on, and the categories it receives, and how
many persons the store recorded as disclosed to it; under it, whether the worker is still telling
it, presumed, what was recorded before it was declared, and how many of its notices wait as failed
[dead letters](#bounda-dead-letters). A port the app no longer declares says so: its notices wait as
dead letters until it is declared again or an operator tells its recipient and discards them. With
no recipient it prints `recipients: none declared`. Exit codes: `0` listed, `1` bad arguments, `2`
the project could not be loaded, or the recipients could not be read, which it says on stderr and
logs.

| Option | Meaning |
| --- | --- |
| `--json` | Print every recipient as JSON, as `app.status()` lists them under `recipients` |
| `--root`, `--config`, `--registry`, `--error-text` | As for `bounda rebuild` |
| `--actor <id>` | Who lists a person's recipients, named in the access log |

## `bounda restrict` and `bounda unrestrict`

Restrict a person's processing, and lift it, from the command line, as `app.restrict` and
`app.unrestrict` do (see [Restricting processing](/guides/personal-data/#restricting-processing)).
Both boot the project as `bounda dead-letters` does, and act as `--actor`.

```bash
bounda restrict c-42 --ground accuracy-contested --actor ops-ana
bounda restrict c-42 --ground legal-claims --category invoices --actor ops-ana
bounda unrestrict c-42 --notice 7d --ground accuracy-contested --actor ops-ana
bounda unrestrict c-42 --notice given --actor ops-ana
```

`bounda restrict <person> --ground <ground>` restricts the person as a whole on that ground of
article 18(1), `accuracy-contested`, `unlawful-processing`, `legal-claims` or `objection-pending`,
and prints `restricted c-42 on accuracy-contested`; with `--category`, repeated for several, only
those categories, and prints `restricted invoices of c-42 on legal-claims`. A restriction that adds
nothing prints `c-42 was restricted on accuracy-contested already`. Without `--ground`, or with
one the article does not name, it fails before booting; a category the app does not have fails
with `VALIDATION_FAILED`, and so does `objection-pending` of a category no objection under article
21(1) is weighed for, or of the person as a whole while the app has one (see [Restricting
processing](/guides/personal-data/#restricting-processing)).

`bounda unrestrict <person> --notice <duration|given>` lifts the person's restrictions: with a
duration, it announces the lift, for the app to tell the person, and lifts it that long after,
printing `announced the lift of the restriction of c-42, lifted 7d from now`; with `given`, for a
person told already, it lifts at once and prints `lifted the restriction of c-42`. `--ground`
lifts only the restrictions on that ground, and `--category`, repeated for several, only those
categories of restrictions of categories. Nothing to lift prints `c-42 has no restriction to
lift`. Without `--notice`, or with one that is not a positive duration or `given`, it fails
before booting.

## `bounda redact`

Correct a person's data from the command line, as `app.redact` does (see [Correcting a person's
data](/guides/personal-data/#correcting-a-persons-data)): it boots the project as `bounda
dead-letters` does, and acts as `--actor`.

```bash
bounda personal-data export c-42 \
  | jq -c '.events[] | select(.data.email == "ana@old.example")
      | {aggregateType, aggregateId, type, id, fields: ["email"]}' > wrong.jsonl
bounda redact c-42 --from wrong.jsonl --actor ops-ana
```

`bounda redact <person> --from <file>` reads the events to redact from the file, one a line as
JSON, each as the person's export lists it, `aggregateType`, `aggregateId`, `type` and `id`, with
the `fields` to seal, and prints `redacted 2 events of c-42`; blank lines are skipped. When what it
lists reads as `null` already it prints `nothing of c-42 left to redact: what was listed reads as
null already`. A line that is not such an object fails before booting, naming the line and never
what it holds; an event the store does not hold, that does not name the person, or a field its
type does not mark `personal` fails with `VALIDATION_FAILED` and nothing is redacted. Append the
corrected value with the app's own command.

## `bounda forgotten` and `bounda forget --from`

Apply again, by hand, the forgettings a restored backup undid, for an app without a
[forget ledger](/guides/personal-data/#backups). `bounda forget` boots the project as
`bounda dead-letters` does; `bounda forgotten` only opens the project's storage and reads its
event store, without starting the app, so a strict forget ledger that is down does not stop it.

```bash
bounda forgotten --since 2026-11-01T03:00:00Z > forgotten.jsonl
bounda forgotten --since 18250 > forgotten.jsonl
bounda forget --from forgotten.jsonl
```

`bounda forgotten` reads the stream and prints, one line of JSON each, the `PersonalDataForgotten`
of every person forgotten since `--since`: a date, compared with each event's time, which reads the
whole stream, or a position of the stream to read after. Each line is
`{"personId":…,"eventId":…,"forgottenAt":…,"reason":…,"fingerprints":[…],"categories":…}`, the
entry a ledger would hold: `categories` `null` for a person forgotten as a whole and else the
categories the forgetting asked for, and no `fingerprints` for a forgetting recorded before Bounda
0.4.0; the count goes to standard error, so standard output is the list alone. Run it against the
database before it is restored, or regularly next to the backups.

`bounda forget --from <file>` commits again each forgetting listed, of the categories it asked for
or of the person as a whole, under its own id, time and reason, unless the database holds it, and
only while the person holds a key in force the line covers and names, as a reconciliation would;
with a forget ledger configured, it records each in the ledger first. A line may also be a bare
person's id, forgotten as a whole, as a request, whenever they hold a key; blank lines are skipped.
A line that records a change of restrictions, a redaction or a disclosure, as a forget ledger
keeps one, is refused: [`bounda forget-ledger apply`](#bounda-forget-ledger-stranded-and-bounda-forget-ledger-apply)
applies those. It prints each person it forgot and how many of those listed:

```
forgot again c-42
forgot again 1 of 3 listed; the rest hold no key the line names, or this store holds their forgetting
```

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--since <date\|position>` | `forgotten` | A date such as `2026-11-01` or `2026-11-01T03:00:00Z`, or a position: a whole number |
| `--from <file>` | `forget` | What `bounda forgotten` printed, or one person's id a line; not with a person |
| `--category <name>` | `forget <person>` | Forget only this category of the person; repeat it for several |
| `--objection` | `forget <person>` | Forget after an objection the app upheld, recorded with `reason: "objection"` |
| `--root`, `--config`, `--registry`, `--error-text` | all | As for `bounda rebuild` |
| `--actor <id>` | `personal-data export`, `forget` | Who acts, named in each `PersonalDataForgotten`, its log line and the access log |
| `--output <file>` | `personal-data export` | Write the export to this file, once whole, instead of standard output |
| `--include-withheld` | `personal-data export` | Open, still marked, what article 15(4) holds back, for the controller to weigh |

Exit codes: `0` done, `1` bad arguments, or a person and `--from` both or neither, `2` the project
could not be loaded, the export or the forget failed, or the file could not be read or has a line
that is neither a person's id nor an entry, in which case nobody is forgotten.

## `bounda freeze-tenant` and `bounda unfreeze-tenant`

[Freezes a tenant](/guides/personal-data/#freezing-a-tenant): from then on no write of it lands,
from this or any running instance, however long ago it last read the tenant, until
`bounda unfreeze-tenant` lifts it; reads go on. What `bounda export-tenant` needs. Each boots the
project for that tenant, unless `--tenant` names another, which it refuses.

```bash
bounda freeze-tenant acme --actor ops-ana
```

```
froze tenant acme at 2026-11-09T10:00:00.000Z: no write of it lands until bounda unfreeze-tenant acme; bounda export-tenant hands it back as one cut
```

`bounda unfreeze-tenant acme` prints `unfroze tenant acme: it takes writes again`. Run again on a
frozen tenant, `freeze-tenant` prints the freeze it finds, and finishes one cut short; a forgotten
tenant refuses both. `bounda status` prints `frozen tenant: since ...` while the tenant is frozen.

| Option | Meaning |
| --- | --- |
| `--root`, `--config`, `--registry`, `--error-text`, `--actor`, `--tenant` | As for `bounda rebuild` |

Exit codes: `0` frozen or unfrozen, `1` bad arguments, `2` the project could not be loaded or the
call was refused or failed.

## `bounda export-tenant`

[Hands a tenant back](/guides/personal-data/#handing-a-tenant-back) to its controller, as
article 28(3)(g) asks of a processor at the end of its service: every person, recipient of their
data with its country and the transfer, its legal regime, safeguard and article, event, scheduled
command, dead letter, subscriber failure, remembered answer, read-model row and forget ledger
entry, with the stores kept in another jurisdiction and the regime of each, every value opened, as [JSON Lines](https://jsonlines.org/), read and written a page at a
time whatever the tenant holds. It boots the project for that tenant, unless `--tenant` names
another, which it refuses, and refuses a tenant not [frozen](#bounda-freeze-tenant-and-bounda-unfreeze-tenant)
in every store. Recorded in the access log, `started` and then how it ended.

```bash
bounda export-tenant acme --output acme.jsonl --actor ops-ana
```

```
exported tenant acme to /srv/acme.jsonl: 1204 persons, 3 recipients, 98112 events, 3 scheduled commands, 0 dead letters, 0 subscriber failures, 12 remembered answers, 40211 read model rows, 37 forget ledger entries; check it with bounda check-tenant-export before forgetting the tenant
```

Without `--output` the lines go to standard output, written as fast as it takes them, and the
summary to standard error. With `--output` the file is written beside its place and moved there
only once whole, readable by its owner alone. The tenant frozen, the export is one cut of every
store; should the stream still move while it reads, as after a restore by hand, it fails without
its `end` line and writes no file.

| Option | Meaning |
| --- | --- |
| `--output <file>` | Write it to this file instead of printing it |
| `--root`, `--config`, `--registry`, `--error-text`, `--actor`, `--tenant` | As for `bounda rebuild` |

Exit codes: `0` exported, `1` bad arguments, `2` the project could not be loaded or the export was
refused or failed.

## `bounda check-tenant-export`

Checks that a file `bounda export-tenant` wrote holds the whole export, as `readTenantExport` does:
a header of the format and version it knows first, every part of a known kind in its place, and
last an `end` whose counts are those of the parts before it. It reads the file alone, without the
project, so it runs wherever the file is, before the tenant is forgotten.

```bash
bounda check-tenant-export acme.jsonl
```

```
/srv/acme.jsonl is a whole export of tenant acme up to position 98112: 1204 persons, 3 recipients, 98112 events, 3 scheduled commands, 0 dead letters, 0 subscriber failures, 12 remembered answers, 40211 read model rows, 37 forget ledger entries
```

Exit codes: `0` whole, `2` the file cannot be read or is not a whole export, with the first thing
out of place on standard error.

## `bounda forget-tenant`

[Forgets a tenant](/guides/personal-data/#forgetting-a-tenant) as a whole: destroys its key, so
nothing personal of it opens again, in the database, its backups or a Durable Object's copies, and
the app serves nothing more but the notices to its recipients. It boots the project for that
tenant, unless `--tenant` names another, which it refuses.

```bash
bounda forget-tenant acme --yes --actor ops-ana
```

```
forgot tenant acme at 2026-11-09T10:00:00.000Z (event 019a0c4e-3c9e-7a1b-9f1e-2b3c4d5e6f70); the app tells its recipients in the background
```

Without `--yes` it forgets nothing and says what it would destroy. Run again on a forgotten tenant,
it prints the forgetting it finds. Its recipients are told by the app's worker, on the next start
of an instance that runs it.

| Option | Meaning |
| --- | --- |
| `--yes` | Confirm: the tenant's data cannot be read again |
| `--despite-legal-obligations` | Destroy too the keys a legal obligation keeps, once their data was handed back |
| `--root`, `--config`, `--registry`, `--error-text`, `--actor` | As for `bounda rebuild` |

Exit codes: `0` forgotten, `1` bad arguments, `2` no `--yes`, the project could not be loaded or
the forgetting was refused.

## `bounda tenant-key rotate` and `bounda tenant-key retire`

[Rotate the tenant's key](/guides/personal-data/#rotating-the-tenants-key): `rotate` puts a new
version in force, under which the worker rewraps every key in the background; `retire` removes the
older versions once nothing is wrapped under them, so a backup that needs them opens nothing
personal any more.

```bash
bounda tenant-key rotate --tenant acme
bounda tenant-key retire --tenant acme
```

```
tenant key 7Kx0Qw9zR2bV1mPq in force; the worker rewraps every key under it, then retire Wn3eT1aaK8sL0dXy with bounda tenant-key retire
retired Wn3eT1aaK8sL0dXy: a backup with keys wrapped under them opens nothing personal any more
```

`retire` refuses while a key is still wrapped under an older version, and until twice the key
cache's time after the version in force was created.

`rotate --reseal` [recovers from a full compromise](/guides/personal-data/#recovering-from-a-full-compromise)
of the database, the tenant key store and the master key: besides the new version, the worker
replaces every key that seals personal data and the database's key, seals everything again under
the new ones and destroys the old. `bounda status` names the step under way on its `reseal` line;
`rotate` and `retire` are refused until the old keys are destroyed, and `rotate --reseal` until it
is complete.

```bash
bounda tenant-key rotate --tenant acme --reseal
```

```
tenant key 4Hq8Vd0eN1xZ7cRm in force; the worker replaces every key that seals personal data and seals it all again under the new ones, which bounda status follows, then retire 7Kx0Qw9zR2bV1mPq with bounda tenant-key retire
```

`rewrap-master` serves a [rotation of the master key](/guides/personal-data/#rotating-the-master-key):
it rewraps under the master key in force the key of every tenant every tenant key store the
configuration names holds, whether their apps run or not, and names each one it rewrapped. A
configuration that is a function of the tenant may give tenants stores of their own, so it reaches
them as `forget-ledger prune --all-tenants` does: from `--tenant`, or `default`, the tenants each
reached tenant's tenant key store and forget ledger list, and those the `tenants` export of
`bounda.config.ts` names, until none is new, reading each store once; each key is rewrapped under
the key wrapper of its tenant's own configuration. There is no flag for one store alone: the
previous master keys can go only once no store holds a key under them. It refuses a `tenants`
export that is not a list of tenant names. It exits with `2` while any
tenant's key could not be rewrapped, or any tenant's configuration or stores could not be listed,
naming each and why, so a deploy keeps the previous keys until it passes:

```bash
bounda tenant-key rewrap-master
```

```
rewrapped acme
rewrapped globex
2 tenant key(s) rewrapped; none is left under a previous master key: remove them
```

On Cloudflare the tenant key store, in keeper Durable Objects or in KV, is reached only from a
Worker: `rewrap-master` exits with `2` there, saying so, and each tenant's object rewraps its own
key when [`createWorker`'s `scheduled`](/adapters/cloudflare/#rotating-the-master-key) wakes it.

Both take `--root`, `--config`, `--registry`,
`--error-text`, `--actor` and `--tenant`. Exit codes: `0` done, `1` bad arguments, `2` the project
could not be loaded or the call was refused.

## `bounda forget-ledger expire`

Gives every entry of a Workers KV [forget ledger](/guides/personal-data/#keeping-the-ledger-short)
the expiration `keepFor` sets: KV expires a key only as it was written, so the keys written before
`keepFor` was set, or while it was longer, keep the expiration they had, none at first. Run it once
after setting or shortening `keepFor`, from the project's root.

```bash
bounda forget-ledger expire --binding FORGET_LEDGER --keep-for 35d
```

It runs the project's own wrangler, logged in to the account: it lists every object's keys under
the ledger, writes again with their expiration those that expire later than `keepFor` after their
forgetting or never, and removes those already past it, through `wrangler kv bulk`. A key that is
not an entry of the ledger is never touched. It prints what it changed:

```
gave 1204 entries the expiration keepFor sets; removed 37 already past it
```

| Option | Meaning |
| --- | --- |
| `--binding <name>` | The KV namespace's binding in `wrangler.jsonc`, as `kvForgetLedger({ binding })` names it |
| `--keep-for <duration>` | The configuration's `keepFor`, such as `35d` |
| `--local` | The local state of `wrangler dev` instead of the deployed namespace |
| `--env <name>`, `--wrangler-config <path>`, `--persist-to <dir>` | As wrangler takes `--env`, `--config` and `--persist-to` |
| `--root <dir>` | The project's root, where wrangler is installed |
| `--error-text` | Print the message of the error it fails on, as [error text](#error-text) says |

Exit codes: `0` done, `1` bad arguments, `2` wrangler failed, is not installed, or
`@bounda-dev/cloudflare` is not; the failure is printed as [error text](#error-text) says.

## `bounda forget-ledger prune`

Prunes a SQL [forget ledger](/guides/personal-data/#keeping-the-ledger-short) past `keepFor` with no
app of the tenant running, as the periodic reconciliation of one that runs does. Run it on a
schedule, from the project's root, for the tenants whose apps do not run:

```bash
bounda forget-ledger prune --all-tenants
```

For each tenant, it removes the entries older than `keepFor` that the tenant's database no longer
needs: those its reconciliation has read past, those whose forgetting, change of restrictions,
redaction or disclosure the database holds, and intentions whose commit never happened that
nothing can apply, decided as the reconciliation decides them, with the registry: the database
stands where the intention was written or further, and the person holds no key it covers and
names, as the app's categories read them, or, for a forgetting for inactivity, the retention would
not forget them now; for a change of restrictions, the database holds a later one; for a
redaction, no field it names holds a value the person's keys still open. It stops at the oldest
entry older than `keepFor` the database has yet to apply, as one a copy restored while the app was
stopped lacks, and keeps it and every later one, so that copy is forgotten again at its next start;
run it again after. A forgotten tenant's ledger is pruned past `keepFor` alone, as its app does. It
opens the tenant's database as an app of the tenant does, through the tenant's keys, only when an
entry older than `keepFor` is there, and creates no table in a database without them. Running
instances of the tenant may run beside it.

With `--all-tenants` it also prunes a tenant's entries in a store its configuration no longer
names, as one it named before its ledger moved, which no app of the tenant reads: there an entry
goes only once the database holds what it records or nothing can apply it, whatever its
reconciliation read of its own ledger. It visits each store once and prunes there every tenant it
holds: two adapters of one kind with the same options are one store, and so are ledgers that give
one `storeId`, as an adapter's do, so a configuration that defines its ledger anew for each tenant
over one database is visited once, not once per tenant. It prints one line per tenant and store:

```
acme: removed the entries before 2026-10-26T03:00:00.000Z
globex: removed the entries before 2026-09-14T08:12:40.511Z; kept from then on those older than keepFor its database has not applied: an app of the tenant applies them when it starts
initech: removed the entries before 2026-10-26T03:00:00.000Z from a store its configuration no longer names
```

An entry kept in a store the configuration no longer names that something would still apply, and
that the ledger it names lacks, or holds from before what its reconciliation reads again, no app
ever applies: the command names the tenant on standard error and fails, until the entry is applied
again with [`bounda forget-ledger apply`](#bounda-forget-ledger-stranded-and-bounda-forget-ledger-apply).

| Option | Meaning |
| --- | --- |
| `--all-tenants` | Every tenant whose entries a ledger's store the configuration names holds, each through its own configuration, in every store that holds them: from `--tenant`, or `default`, the tenants each reached tenant's ledger and tenant key store list, and those the `tenants` export of `bounda.config.ts` names, until none is new |
| `--tenant <name>` | The tenant to prune, as [which tenant](#which-tenant) says |
| `--root <dir>`, `--config <file>`, `--registry <file>` | As every command that loads the project takes them |
| `--error-text` | Print the message of the error it fails on, as [error text](#error-text) says |

It refuses a configuration without `runtime.personalData.forgetLedger` or its `keepFor`, a ledger
that expires its entries on its own, as Workers KV and the keeper do (for KV keys written before
`keepFor` was set, run [`bounda forget-ledger expire`](#bounda-forget-ledger-expire)), a storage
only its host opens, as a Durable Object's, and, for `--all-tenants`, a ledger of your own without
`tenants` and a `tenants` export that is not a list of tenant names. With `--all-tenants`, a tenant
whose configuration or stores cannot be read is named on standard error, as a tenant that could
not be pruned is, and the others are pruned all the same. Exit codes: `0` done, `1` bad
arguments, `2` refused, a tenant could not be listed or pruned, or a store its configuration no
longer names keeps an entry no app applies.

## `bounda forget-ledger stranded` and `bounda forget-ledger apply`

Apply again, by hand, the entries of a tenant no app applies, as a store its configuration no
longer names keeps after its ledger moved, which `bounda forget-ledger prune --all-tenants` names:

```bash
bounda forget-ledger stranded --tenant acme > stranded.jsonl
bounda forget-ledger apply --tenant acme --from stranded.jsonl --actor ops-ana
```

`bounda forget-ledger stranded` prints, one line of JSON each, the entry as a forget ledger keeps
it, every entry of the tenant its database lacks, that something would still apply, decided as the
reconciliation decides it with the registry, and that no reconciliation reads: in a store reached
as `--all-tenants` reaches them, from the tenant, the default tenant and those the `tenants`
export names, that its configuration no longer names, unless the ledger it names holds it where
its reconciliation reads; or in that ledger, from before there. A forgetting for inactivity is left
to the retention. The count goes to standard error, so standard output is the list alone:

```
2 entries of acme no app applies
```

`bounda forget-ledger apply --from <file>` boots the tenant's app and applies each line again, in
the order given, as the reconciliation applies it: a forgetting, a change of restrictions, a
redaction or a disclosure, under its own id and time, decided by the same checks in the
transaction that applies it, and recorded first in the forget ledger the configuration names. One
command takes every kind because their order matters: a change of restrictions applies only while
no later one is held. It prints a line per entry and a count:

```
applied again: the forgetting 019a3f2c-… of c-42
held already: the restriction 019a3f2d-… of c-42
left to the reconciliation, which reads it in the ledger: the forgetting 019a3f30-… of c-7
refused, nothing of it applies to the database as it stands: the redaction 019a3f31-… of c-9
applied again 1 of 4 listed; 1 held already, 1 left to the reconciliation, 1 refused as applying nothing
```

An entry the database holds is held already, so the same list applies again safely; one the ledger
the configuration names holds where its reconciliation reads is left to the reconciliation, which
counts the restore its loss tells; one nothing applies any more, a forgetting of a person who holds
no key it names, a change of restrictions a later one followed, a redaction whose fields open for
no one, a disclosure whose category was forgotten since, is refused. A copy taken between an
entry's time and when it was applied again lacks it, and its cursor read past it: after restoring
such a copy, apply the same list again.

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--from <file>` | `apply` | What `bounda forget-ledger stranded` printed |
| `--actor <id>` | `apply` | Who acts, named in each event appended and its log line |
| `--tenant <name>` | both | The tenant, as [which tenant](#which-tenant) says |
| `--root`, `--config`, `--registry`, `--error-text` | both | As for `bounda rebuild` |

Both refuse a configuration without `runtime.personalData.forgetLedger` and a storage only its host
opens, as a Durable Object's. Exit codes: `0` done, `1` bad arguments, `2` the project could not be
loaded, the listing or the apply failed, a tenant's stores could not be listed, so a store only it
names may hold more, or the file could not be read or has a line that is not a forget ledger's
entry, in which case nothing is applied.

## Programmatic use

`bounda generate` is exported from `@bounda-dev/cli` as `generate`:

```ts
import { generate } from "@bounda-dev/cli";

const report = await generate({ root: process.cwd() });
report.written; // absolute paths written this run
report.warnings; // layout and inference warnings, per aggregate or read model
```

It throws `ConventionError` when the layout breaks a convention; `formatConventionError` and
`formatWarnings` format the error and the warnings as the command prints them. `bounda rebuild` is `rebuildReadModel` from
`@bounda-dev/core` over a project loaded with `loadProject` from `@bounda-dev/core/node`, with
`actor` for `--actor`; an app exposes the same as `app.rebuildReadModel(name)`, and
`app.as(actor).rebuildReadModel(name)`. `bounda status` is `app.status()`, and its failures' text
`app.as(actor).subscriberFailures.list()`; `bounda migrate` is `migrateTables({ config })` from
`@bounda-dev/core`; `bounda restore` is `adapter.restore({ copy })` on the storage
`withEncryptedFiles` opens; `bounda restored` is `app.restored()`. `bounda dead-letters` is `app.deadLetters` on a booted app,
or `app.as(actor).deadLetters`, `bounda personal-data export` is
`personalDataExportJson(await app.as(actor).streamPersonalData(person))`,
`bounda forget <person>` is `app.as(actor).forget(person, { categories, objection })`,
`bounda forget --from` is `app.forgetAgain(entries, { actor })`, `bounda export-tenant` is
`tenantExportJsonLines(await app.as(actor).exportTenant(tenant))`, `bounda freeze-tenant` and
`bounda unfreeze-tenant` are `app.as(actor).freezeTenant(tenant)` and
`app.as(actor).unfreezeTenant(tenant)`, `bounda check-tenant-export`
is `readTenantExport(createReadStream(file))`, `bounda forget-tenant` is
`app.as(actor).forgetTenant(tenant, options)`, and `bounda tenant-key` is `app.rotateTenantKey(options)`
and `app.retireTenantKeys()`, each on an app booted with `boot({ tenant })`, and
`rewrapTenantKeys({ config: projectConfig, env, tenants: await tenants() })` for `rewrap-master`. `bounda forget-ledger prune` is
`pruneTenantForgetLedger({ config, registry, env, tenant })` from `@bounda-dev/core`, on the
configuration and registry `loadProject` resolves for the tenant, and `--all-tenants` runs it for
each tenant `listForgetLedgerTenants({ config: projectConfig, env, tenants: await tenants() })`
lists, in each of the `stores` that hold its entries, given as `store` unless the store's `named`
holds the tenant, with `projectConfig` and `tenants` from `loadProject`. `bounda forget-ledger
stranded` is `listStrandedForgetLedgerEntries({ config: projectConfig, registry, env, tenant,
tenants })`, and `bounda forget-ledger apply` is `app.applyAgain(entries, { actor })`. The
commands boot the app with `createConsoleLogger({ stream: process.stderr })` from
`@bounda-dev/core/node`, which writes every level to the stream it is given.
