---
title: CLI
description: "The bounda command: generate the registry and the types, rebuild a read model, deal with dead letters, read the runtime's status and migrate its tables."
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
carry the text of errors for that run; a configuration that sets `errorText: "include"` does the
same without it. What fails before any handler runs is printed in full: a configuration or a
registry that cannot be loaded, a read model that is not in the registry, a list `forget` cannot
read, and errors whose message Bounda writes from names and ids alone, such as a dead letter that is
not found or was already settled. To read what a reaction failed on, read its letter:
`bounda dead-letters list` opens the text it keeps encrypted, an access the access log records.
What a subscriber, a projection say, failed on last is in `bounda status --error-text`, recorded
the same way.

## Who runs a command

`--actor <id>` names who runs a command that acts or reads personal data: `rebuild`,
`dead-letters list`, `retry` and `discard`, `status`, and `forget`. The command acts as that id, as
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
| `--kind <kind>` | `list` | `policy`, `process` or `scheduled` |
| `--status <status>` | `list` | `failed` (default), `retried` or `discarded` |
| `--handler <name>` | `list` | The policy or process name as the letter records it, e.g. `order.notifyOnOrderPlaced`, or the scheduled command's type, e.g. `PlaceOrder` |
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
  storage  storage  2 of 2
  storage  checkpoints  1 of 1
  forgetLedger  forget-ledger  1 of 1
restores found while running: 0
subscribers (head at 1204)
  projection:customerDirectory  at 1197, 7 behind
    failing: Error on CustomerRegistered at 1198, 4 attempts since 2026-11-09T10:02:11.000Z
  policies  at 1204, 0 behind
personal data backfill: sealed through position 1204, caught up
forget ledger: reconciled, applied through 2026-11-08T22:15:00.000Z, last run 2026-11-09T10:00:00.000Z
key rotation: under 7Kx0Qw9z (previous Wn3eT1aa), 12 keys left to rewrap
retention: 730d, 0 persons past it, next due 2028-01-04T09:13:00.000Z
dead letter retention: 30d, next purge 2026-11-20T08:00:00.000Z
```

- `tables`: each scope of Bounda's tables, in each database the configuration names (`storage`,
  `readModels.<name>` for read models in a database of their own, `forgetLedger`), at the version
  the database holds of the one this release migrates it to; one behind says
  `(migrations pending: bounda migrate)`. A store without tables, as `memory()`, has none.
- `restores found while running`: how many times a running instance found the database gone back
  to an earlier copy ([restores while running](/guides/personal-data/#restores-while-running)).
- each subscriber's checkpoint and lag, and its last failure, by any instance: `failing` while it is
  still stuck on it, `last failed, resolved …` once it got past. Its class and code, the event, how
  many deliveries in a row failed and since when; never its text.
- the [backfill](/guides/personal-data/#marking-a-field-later) of personal data, the forget
  ledger's [reconciliation](/guides/personal-data/#what-the-runtime-does-with-it), the
  [rotation](/guides/personal-data/#rotating-the-master-key) of the master key, the
  [retention](/guides/personal-data/#inactivity) and the [purge of resolved dead
  letters](/guides/dead-letters/#keeping-resolved-letters), each `not configured` when it is off.

`--error-text` also prints, under each failure, the text it keeps, encrypted under the person the
event names: it is read through `app.subscriberFailures.list()`, which records it in the
[access log](/guides/personal-data/#who-opened-what) with the persons and `--actor`. A failure whose
person was forgotten says its text went with them.

| Option | Meaning |
| --- | --- |
| `--json` | Print `app.status()` as JSON; with `--error-text`, `subscriberFailures` holds the failures with their text |
| `--root`, `--config`, `--registry`, `--error-text` | As for `bounda rebuild` |
| `--actor <id>` | Who reads the failures' text with `--error-text`, named in the access log |

## `bounda migrate`

Brings Bounda's tables to this release's version in every database the configuration names, as
the first instance to start would, and prints the versions after:

```bash
bounda migrate
```

```
migrated
  storage  storage  2 of 2
  storage  checkpoints  1 of 1
  readModels.reports  checkpoints  1 of 1
```

It reads only the configuration, never the registry, and starts no app: run it as a step of the
deploy, after stopping the previous version and before starting the new one (see
[Schema](/guides/deployment/#schema)). Each database migrates under its own lock, as a start does,
so running it twice, or while an instance starts, migrates once. Tables a newer release migrated
are refused untouched with [`STORAGE_SCHEMA_TOO_NEW`](/reference/errors/#codes).

| Option | Meaning |
| --- | --- |
| `--root <dir>` | The project root, the current directory by default |
| `--config <file>` | The configuration module under the root, `bounda.config.ts` by default |

Exit codes: `0` migrated, `1` bad arguments, `2` the configuration could not be loaded or a
migration failed.

## `bounda forgotten` and `bounda forget`

Apply again, by hand, the forgettings a restored backup undid, for an app without a
[forget ledger](/guides/personal-data/#backups). Both boot the project as `bounda dead-letters`
does.

```bash
bounda forgotten --since 2026-11-01T03:00:00Z > forgotten.jsonl
bounda forgotten --since 18250 > forgotten.jsonl
bounda forget --from forgotten.jsonl
```

`bounda forgotten` reads the stream and prints, one line of JSON each, the `PersonalDataForgotten`
of every person forgotten since `--since`: a date, compared with each event's time, which reads the
whole stream, or a position of the stream to read after. Each line is
`{"personId":…,"eventId":…,"forgottenAt":…}`, the entry a ledger would hold; the count goes to
standard error, so standard output is the list alone. Run it against the database before it is
restored, or regularly next to the backups.

`bounda forget --from <file>` forgets again, with `reason: "restored"`, each person listed who
still holds a key, unless the database holds the forgetting the line names by `eventId`. A line
may also be a bare person's id, forgotten whenever they hold a key; blank lines are skipped. It
prints each person it forgot and how many of those listed:

```
forgot again c-42
forgot again 1 of 3 listed; the rest hold no key, or this store holds their forgetting
```

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--since <date\|position>` | `forgotten` | A date such as `2026-11-01` or `2026-11-01T03:00:00Z`, or a position: a whole number |
| `--from <file>` | `forget` | What `bounda forgotten` printed, or one person's id a line |
| `--root`, `--config`, `--registry`, `--error-text` | both | As for `bounda rebuild` |
| `--actor <id>` | `forget` | Who forgets them again, named in each `PersonalDataForgotten` and its log line |

Exit codes: `0` done, `1` bad arguments, `2` the project could not be loaded, or the file could not
be read or has a line that is neither a person's id nor an entry, in which case nobody is forgotten.

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
`@bounda-dev/core`. `bounda dead-letters` is `app.deadLetters` on a booted app,
or `app.as(actor).deadLetters`, and `bounda forget` is `app.forgetAgain(entries, { actor })`. The
commands boot the app with `createConsoleLogger({ stream: process.stderr })` from
`@bounda-dev/core/node`, which writes every level to the stream it is given.
