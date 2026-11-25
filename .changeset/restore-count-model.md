---
"@bounda-dev/core": minor
"@bounda-dev/cloudflare": minor
---

Count restores against a model of every interleaving of copies, restores, crashes, two instances, a ledger that fails and `bounda restored`, and fix what it found:

- every look reads the forget ledger's mark before the database, so a pass finds a copy another instance told the ledger of, and no move of the counter passes a mark nobody compared;
- an instance that stops after a copy came back under it, before it looked again, raises the mark past what it saw, so the next look counts the restore;
- the count of restores goes to the ledger as a mark too (`restore:count`), so `restoresFound` counts every restore found, one on a copy a later restore took back included;
- a restore found while the ledger could not be read is not counted again when a later reconciliation applies what it lost (`forget-ledger:reconciled`);
- a committed entry is applied at once, however young, and one whose event the database lacks tells a restore even when its person was forgotten again by an earlier entry, or nothing is left to apply, when it was written where the database still stands;
- a start declares at once the restore an entry written past the database tells, though it forgets nobody;
- on Workers KV, each raise of a mark is a key of its own, so a mark never goes down whatever the raise read, and an intention whose put landed after its committed copy is removed, behind the fence, by the next read that lists both.
