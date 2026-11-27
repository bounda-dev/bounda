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
- Keep the [tenant key store](/guides/personal-data/#the-tenant-key-store) apart from the
  database, and back it up apart: a restore of the database never touches it, which is what lets a
  [forgotten tenant](/guides/personal-data/#forgetting-a-tenant) stay forgotten in every copy.
  Never restore a backup of it taken before a tenant's forgetting: the tenant's key comes back
  with it, and the forget ledger no longer holds the tenant's entries once its recipients were
  told.
- Keep every version of the tenant's key a backup's keys are wrapped under, and every [master
  key](/guides/personal-data/#rotating-the-master-key) a backup of the tenant key store was taken
  under, as long as the backup: retire an older version of the tenant's key only once the backups
  that need it have expired, or they open nothing personal. After a
  [reseal](/guides/personal-data/#recovering-from-a-full-compromise), the backups taken before it
  hold the keys that leaked: keep the versions they need only as long as you may restore one, and
  reseal again after restoring it.
- Back up the read models that live in [another database](/reference/configuration/) on the
  same schedule as the storage. Restoring them from another moment than the stream is safe, as
  [read models in another database](#read-models-in-another-database) says, but a read model that
  has to be projected again serves nothing until it is.

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

- **SQLite.** Copy the backup to the database's path, or next to it and point `path` at it. On
  Windows a libSQL file can stay locked after the adapter closes, until the process exits: replace
  it only once the app's process has stopped, or run `bounda restore` as below.
- **PostgreSQL.** `pg_restore`, or a point-in-time restore to another server and `url` pointed at
  it.
- **Durable Object.** `ctx.storage.onNextSessionRestoreBookmark(bookmark)` with a bookmark from
  `getBookmarkForTime`, then `ctx.abort()`: the object restarts on the restored storage. Restore
  the tenant's object, never its [keeper](/adapters/cloudflare/#tenant-keys), which holds the
  tenant's key and the ledger a restore is reconciled with.

The app finds the restore before it serves anything, by the forget ledger's mark, reads the
ledger, forgets again whoever the copy brought back, and the read models hear of it before the
start resolves. A ledger that does not answer within ten seconds is left to finish in the
background, unless the ledger is [strict](/guides/personal-data/#what-the-runtime-does-with-it).
Without a forget ledger nothing outside the database says it went back: run `bounda restored`,
then [`bounda forget --from`](/reference/cli/#bounda-forgotten-and-bounda-forget---from) with the
list of whom you forgot since the copy, saved before the restore.

Under a running app, restore in place, in one transaction, so the app sees the database as it was
or as the copy has it, never half restored:

- **SQLite.** From the project's root, with the app running or not:

  ```bash
  bounda restore /backups/app.db
  ```

  It opens the copy, under the tenant's keys when the file is encrypted, and puts every table,
  index and trigger of it back in one write transaction through libSQL, the app's own engine,
  bringing Bounda's tables to the versions the database held; a copy of another tenant's database,
  or one a newer version of Bounda migrated, is refused and nothing changes. The restore is counted
  in the same transaction: every instance finds it, running or started after, with a forget ledger
  or without one, so no `bounda restored` is needed. A statement of the app that waits for the
  transaction past the busy timeout fails, as one that met any other lock does. The database keeps
  its own [fence](/guides/personal-data/#freezing-a-tenant), whatever the copy's: a forgotten
  tenant stays forgotten, and a frozen one refuses the restore, with `TenantFrozenError`, until it
  is unfrozen, since a restore is a write the export it is frozen for would not see.
  `adapter.restore({ copy })` is the same in code.
- **PostgreSQL.** `pg_restore --clean --if-exists --single-transaction --schema <schema>`. It
  brings back the copy's fence with the rest: restore a frozen tenant only once it is unfrozen, and
  freeze it again after if you need it frozen (see [Limitations](/reference/limitations/)).

The `sqlite3` shell's `.restore` writes the file from another process in one transaction too, and
leaves it whole: in our tests, with libSQL writing to it all along, it passed `PRAGMA
integrity_check` every time. What it broke was libSQL's connection: a statement that waited for it
past the busy timeout left the connection inside a transaction no other one saw, which went on
writing what was lost when it closed, and held the file's lock. The adapter opens its connections
afresh after such a wait, so any long write from another process leaves the app as it was;
`bounda restore` also opens a copy encrypted under the tenant's keys, which the shell cannot.

Every instance finds it on its next pass, before the pass delivers any event or claims any
scheduled command, and an instance in the `web` role within five seconds;
[restores](/guides/personal-data/#restores) says how. It logs

```
the database went back to an earlier copy; background jobs start over
```

and reads the ledger at once. A request served between the restore and that pass reads the copy as
it is, unless the ledger is [strict](#strict-reads). A Durable Object has no running app to restore
under: restoring its storage restarts it.
An app without a forget ledger logs an error as well, since it has no record of whom to forget.

## Read models in another database

A read model in a [database of its own](/reference/configuration/) is restored apart from the
stream, and can come back from another moment than it:

- **Behind the stream**, its copy older than the stream's: it holds rows of persons forgotten or
  restricted since. Bounda keeps, in the storage's database, the furthest checkpoint each of its
  subscribers reached, and a read model whose database stands behind it serves nothing until it
  is back there.
- **Ahead of the stream**, the stream restored from an earlier copy: it holds rows of persons the
  stream no longer has, and its checkpoint stands past positions the stream takes again, so the
  forgettings the ledger commits once more would never reach it. Every checkpoint in such a
  database is marked with the event it stands at; a mark the stream does not hold at that position
  empties the read model and projects it again from the start, and its database's copy of who is
  restricted with it.

Both are found at start, before the app serves anything, which waits for those read models to be
projected back; and while it runs, on every pass, and within five seconds in the `web` role. Until
then a query of such a read model, or an export, is refused with
[`READ_MODEL_RESTORING`](/reference/errors/#codes): try again once it caught up. A refused export,
or query of a read model with personal fields, is in the
[access log](/guides/personal-data/#who-opened-what) as `refused`, having read nothing. A copy taken in the
five seconds before a checkpoint was recorded differs from it as a projection that lags does, and
catches up as one.

## Strict reads

With a [strict](/guides/personal-data/#what-the-runtime-does-with-it) forget ledger, every query,
export, and read of the dead letters and of the subscribers' failures checks after it read that the
database did not go back meanwhile, by the same counters and newest event the passes check, and
that the read model's database of its own stands where it did.
A restore found then, or one the ledger is not yet reconciled with, refuses the read with
[`RESTORE_UNRECONCILED`](/reference/errors/#codes), the ledger's error as its `cause` when it could
not be read: the reconciliation runs at once, and the read models project what it committed again
before anything is served. The read after succeeds, and a refused read is in the [access
log](/guides/personal-data/#who-opened-what) as `failed`. Each read costs the reads of the check,
shared by the reads that run at once; an export checks once its header is read and once for each
page that holds anything for the person, before it hands out any of it.

## What is guaranteed

Bounda's restore tests run this on SQLite (node:sqlite and libSQL, in the clear and encrypted),
PostgreSQL and the Durable Object, with the app stopped and, where the engine allows it, running:
persons write their data, a backup is taken, some are forgotten, the master key rotates, more is
written, and the copy is restored; a backup is taken, the tenant is forgotten, and the copy is
restored; and the stream and a read model's database of its own are each restored from another
moment than the other.

- **Whoever was forgotten after the copy is forgotten again,** their `PersonalDataForgotten`
  committed once more under the id, time and reason the ledger recorded before it first committed:
  no key,
  snapshot, remembered answer that opens or scheduled command of theirs, no row a projection
  of `PersonalDataForgotten` removes, their fields `null` in the export, in every event and dead
  letter and in the state of their processes, and none of their values in any row of the
  database.
- **Their scheduled commands never run**, even when they fall due as the copy comes back.
- **A forgetting of some categories alone** goes again for those categories alone, and what a
  [erasure exemption](/guides/personal-data/#categories) keeps after a person is forgotten stays readable.
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
- **What a port disclosed after the copy is recorded again,** from the first disclosure of each
  category of a person to a [recipient](/guides/personal-data/#recipients) the ledger holds, unless
  a forgetting of that category came after it: a later forgetting tells that recipient. Without a
  ledger, every recipient is presumed to hold the data of every person whose data existed when the
  restore was found.
- **Whoever was forgotten before the copy stays forgotten,** once: the copy holds their forgetting.
  Someone who registered after the copy is gone with it, and their entry in the ledger finds no
  key to remove.
- **Everyone else reads as before,** their keys wrapped under an older version of the tenant's
  key open while the record holds it, and are rewrapped under the current one; a tenant key wrapped
  under the previous master key opens and is rewrapped too.
- **A tenant forgotten after the copy stays forgotten:** its key is gone from the tenant key store,
  so nothing personal of the copy opens, and the app that starts on it serves nothing, removes the
  copy's keys, snapshots, remembered answers and read model rows, and appends the
  `TenantForgotten` the copy lacks, under the id and time the store recorded. Until it starts, a
  read model's fields not marked `.personal()` are in the clear in the copy, as they were in the
  database.
- **A copy taken during a [reseal](/guides/personal-data/#recovering-from-a-full-compromise)**
  goes on with it from the step the copy holds, and one taken before it holds the keys the reseal
  replaced: whoever a forgetting since named is forgotten again all the same, since the ledger
  names the keys a reseal replaced along with those that took their place.
- **A read model in a database of its own** serves, once the restore is found, nobody the stream
  does not hold, nobody forgotten or restricted since, and everyone else, whichever of the two was
  restored, and from whichever moment.
- **A strict app hands out nothing it read from a copy** restored under it before the ledger is
  reconciled with it.
- **The app goes on:** projections stay current, new persons register, `forget` and the rotation
  work, and the next normal start forgets nobody again. A failed reconciliation the copy
  remembers does not hold the restored start back, and `bounda status` counts the restore.
- **Each restore is counted once:** one an instance finds under the running app is not found again
  by the next start; one only a stopped instance saw is counted by the next look; one found while
  the ledger could not be read is not counted again when it is reconciled, nor when the ledger
  takes only later a forgetting it lost, or two instances count it while the ledger cannot say
  the latest count; an intention whose
  commit never reached the ledger still tells a copy taken before the newest event it saw; a
  forgetting committed a moment before the copy came back tells it at once; `bounda status` counts
  every restore found, past one on a copy a later restore took back; and `bounda restored` run again
  where handling the last restore left the database counts nothing, unless `--again` says the copy
  was taken right then, or the ledger tells a restore counted since, which on Workers KV it waits
  a minute after the start to read. Restore counting is also tested against
  [a model](/guides/personal-data/#restores) of every interleaving of copies, restores, crashes,
  two instances and a ledger that fails.
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

`hot` says whether the engine restores in place under a running app; `restore` is then given the
adapter the app opened, through which a file encrypted under the tenant's keys restores, as
`bounda restore` does. Each forgotten person is
checked with [`expectForgotten`](/guides/personal-data/#in-tests) over the adapter's `inspect`, every table
under its prefix, and over what the app reads back of them.
