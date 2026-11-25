---
"@bounda-dev/core": minor
"@bounda-dev/postgresql": patch
"@bounda-dev/cloudflare": patch
---

A restore is counted exactly. A forgetting, restriction or redaction whose commit never came, because the process stopped or the transaction failed after its intention reached the forget ledger, was counted as a restore at the next start or periodic round, since the ledger held an entry the database lacked. The ledger now tells an intention from a commit: an intention reads `committed: false` until the commit returns, which appends it again as committed, as the stream's copy does after. Only a committed entry the database lacks counts as a restore, at a start, on a periodic round or before a freeze; an intention is applied again as asked and counts none. The tenth version of the SQL ledger's scope adds the column, every entry written before reading as committed.

`restores.declare()`, what `bounda restored` and `app.restored()` run, counted a restore and then raised the ledger's mark, so a mark that failed after the count made a retry count the same restore twice. A declaration now raises the mark before it counts, so a mark it cannot raise fails it with nothing counted; it writes the count it moves to before counting, so one that fails part way is finished by the next declaration or start rather than counted again; and one made while the database stands where the last restore handled left it, or after a start or `bounda restore` that counted the same restore, counts nothing more.

A start that found a restore, counted in place by `bounda restore` or from the ledger's mark, and then failed to read or raise the mark, returned no restore while taking it as handled, so the app never handled it. It now handles it, and compares the mark on a later check.

Breaking for a ledger of your own: `ForgetLedgerEntry.committed` is `false` on an intention, and `append` must read an entry committed once it is appended without it, in the same call or a later one, whatever is appended after. `forgetLedgerContract` checks it.
