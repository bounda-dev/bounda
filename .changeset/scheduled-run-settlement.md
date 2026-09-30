---
"@bounda-dev/core": patch
---

The scheduled-command worker commits a run together with the release of its claim: what a delayed
command, a delayed policy run or a process deadline wrote lands in the same transaction as the
claim's completion, so a worker that dies between the two does not run it twice, and a run the
worker gives up on is dead-lettered in the transaction that drops it. Replaying a policy or
command dead letter marks it `replayed` in the same transaction as the replay's writes; a process
letter is marked once its instance has drained what was parked, so a replay cut short there is
taken up again by replaying the same letter.

Inside a policy or process handler, `commands` always write to the attempt's unit of work now;
the cancellation of a failed run's delayed commands, which that made unnecessary, is gone.
