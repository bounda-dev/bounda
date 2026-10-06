---
"@bounda-dev/core": minor
---

Replaying the dead letter of a dropped command that its aggregate now rejects marks the letter
`replayed`, as the scheduler would have settled it, instead of throwing the `DomainError` and
leaving the letter `failed`. The rejection is logged as `command rejected`.

`runUntilIdle().rejections` counts the rejections of a policy or process run that is retried only
from the attempt that commits, instead of once per attempt.

A command's `rejections` that throws, or has no message for the code its handler rejects with, no
longer turns the rejection into a failure or passes unnoticed: the rejection stands with the code
as its message, and the runtime logs a warning.

A logger that throws, or whose `async` methods reject, no longer fails what was being logged:
`createApp`, `boot` and `rebuildReadModel` ignore it. Collaborators and adapters receive that
guarded logger.
