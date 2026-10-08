---
"@bounda-dev/core": patch
---

The scheduled-command worker commits a run together with the release of its claim: what a scheduled
command, a delayed policy run or a process deadline wrote lands in the same transaction as the
claim's completion, so a worker that dies between the two does not run it twice, and a run the
worker gives up on is dead-lettered in the transaction that drops it. Retrying a policy or
scheduled command dead letter marks it `retried` in the same transaction as the retry's writes; a process
letter is marked once its instance has drained what was parked, so a retry cut short there is
taken up again by retrying the same letter.

Inside a policy or process handler, `commands` always write to the attempt's unit of work now;
the cancellation of a failed run's scheduled commands, which that made unnecessary, is gone.
