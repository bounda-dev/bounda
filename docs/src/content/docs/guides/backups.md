---
title: Backups and restores
description: Taking a backup, restoring it with the app stopped or running, and what Bounda guarantees about the persons forgotten or restricted in between.
sidebar:
  order: 12
---

A backup is a copy of the database at one moment. Restoring it takes every table back to that
moment, the keys of the persons forgotten since included, so their data would open again. With a
[forget ledger](/guides/personal-data/#the-forget-ledger), a record of every forgetting and every
change of a person's restrictions kept outside the database, Bounda forgets them again, and
restricts again or lifts again whoever was restricted or lifted since. This page is what an
operator does, and what the runtime then guarantees.

## Before you need one

- Configure a [forget ledger](/guides/personal-data/#the-forget-ledger) in a store the restore
  does not touch, and set its `keepFor` longer than your oldest backup.
- Keep every [master key](/guides/personal-data/#rotating-the-master-key) a backup was taken under
  as long as the backup: a backup restored after a rotation opens only with the old key in
  `previous`, and the worker rewraps its keys under the current one again.
- Keep the read models that live in [another database](/reference/configuration/) on the same
  schedule as the storage, and restore both to the same moment.

## Taking a backup

Take it with the app running, with the engine's own tools: they copy a consistent snapshot while
the app writes.

- **SQLite.** `VACUUM INTO '/backups/app.db'`, or the `.backup` command of the `sqlite3` shell.
- **PostgreSQL.** `pg_dump --format custom`, of the schema the adapter uses, or the provider's
  point-in-time recovery.
- **Durable Object.** Nothing to do: Cloudflare keeps 30 days of point-in-time history of every
  object's storage.

## Restoring

At start, stop the app, put the copy back and start it:

- **SQLite.** Copy the backup to the database's path, or next to it and point `path` at it.
- **PostgreSQL.** `pg_restore`, or a point-in-time restore to another server and `url` pointed at
  it.
- **Durable Object.** `ctx.storage.onNextSessionRestoreBookmark(bookmark)` with a bookmark from
  `getBookmarkForTime`, then `ctx.abort()`: the object restarts on the restored storage.

The app finds the restore before it serves anything, by the forget ledger's mark, reads the
ledger, forgets again whoever the copy brought back, and the read models hear of it before the
start resolves. A ledger that does not answer within ten seconds is left to finish in the
background, unless the ledger is [strict](/guides/personal-data/#what-the-runtime-does-with-it).
Without a forget ledger nothing outside the database says it went back: run `bounda restored`,
then [`bounda forget --from`](/reference/cli/#bounda-forgotten-and-bounda-forget) with the list of
whom you forgot since the copy, saved before the restore.

Under a running app, restore in place, in one transaction, so the app sees the database as it was
or as the copy has it, never half restored:

- **SQLite.** In one write transaction on the app's own engine. Stop the app first to restore a
  libSQL database with the `sqlite3` shell's `.restore`: SQLite's backup API, run by another
  library on a file libSQL has open, left it corrupted in our tests.
- **PostgreSQL.** `pg_restore --clean --if-exists --single-transaction --schema <schema>`.

Every instance finds it on its next pass, before the pass delivers any event or claims any
scheduled command, and an instance in the `web` role within five seconds;
[restores](/guides/personal-data/#restores) says how. It logs

```
the database went back to an earlier copy; background jobs start over
```

and reads the ledger at once. A request served between the restore and that pass reads the copy as
it is. A Durable Object has no running app to restore under: restoring its storage restarts it.
An app without a forget ledger logs an error as well, since it has no record of whom to forget.

## What is guaranteed

Bounda's restore tests run this on SQLite (node:sqlite and libSQL), PostgreSQL and the Durable
Object, with the app stopped and, where the engine allows it, running: persons write their data,
a backup is taken, some are forgotten, the master key rotates, more is written, and the copy is
restored.

- **Whoever was forgotten after the copy is forgotten again,** their `PersonalDataForgotten`
  committed once more under the id, time and reason the ledger recorded before it first committed:
  no key,
  snapshot, idempotency record of a rejection or scheduled command of theirs, no row a projection
  of `PersonalDataForgotten` removes, their fields `null` in the export, in every event and dead
  letter and in the state of their processes, and none of their values in any row of the
  database.
- **Their scheduled commands never run**, even when they fall due as the copy comes back.
- **A forgetting of some categories alone** goes again for those categories alone, and what a
  [legal obligation](/guides/personal-data/#categories) keeps after a person is forgotten stays readable.
- **A forgetting whose commit never happened**, recorded in the ledger by a process that stopped
  before committing it, is committed at the restored start too.
- **A strict ledger that cannot be read** fails the restored start before it serves anything; the
  next start, once it can, applies the whole restore.
- **Whoever was [restricted](/guides/personal-data/#restricting-processing) after the copy is
  restricted again, and whoever's restriction was lifted is lifted again,** each change committed
  once more with the id and time the ledger recorded before it first committed, in order: their
  rows leave the queries, their commands are refused, and a lift announced is scheduled again. A
  change whose commit never happened is committed at the restored start too, unless a later change
  of that person's restrictions is in the copy.
- **Whoever was forgotten before the copy stays forgotten,** once: the copy holds their forgetting.
  Someone who registered after the copy is gone with it, and their entry in the ledger finds no
  key to remove.
- **Everyone else reads as before,** their keys wrapped under the previous master key open and are
  rewrapped under the current one.
- **The app goes on:** projections stay current, new persons register, `forget` and the rotation
  work, and the next normal start forgets nobody again. A failed reconciliation the copy
  remembers does not hold the restored start back, and `bounda status` counts the restore.
- **Without a forget ledger,** `bounda restored` counts the restore and starts the jobs over, and
  `bounda forget --from` forgets again whom you list; `bounda restrict` restricts again whom you
  know was restricted since.

What ran after the copy was taken runs again: scheduled commands of persons nobody forgot, and
reactions to events the copy holds but its subscribers had not reached yet. Effects outside the
database, such as an email, happen twice unless their receiver deduplicates them.

## For adapter authors

`restoreContract` from `@bounda-dev/core/adapter/testing` is the scenario above. Give it a fresh
database, a ledger store apart from it, and the engine's backup and restore:

```ts
import { restoreContract } from "@bounda-dev/core/adapter/testing";

describe("my adapter", () => {
  restoreContract({
    hot: true,
    create: async () => ({
      storage: myAdapter({ url }),
      forgetLedger: myAdapter({ url: ledgerUrl }),
      backUp: () => takeBackup(),
      restore: async () => {
        await putTheBackupBack();
        return myAdapter({ url });
      },
    }),
  });
});
```

`hot` says whether the engine restores in place under a running app. Each forgotten person is
checked with [`expectForgotten`](/guides/personal-data/#in-tests) over the adapter's `inspect`, every table
under its prefix, and over what the app reads back of them.
