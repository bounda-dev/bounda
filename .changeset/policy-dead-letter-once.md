---
"@bounda-dev/core": patch
---

A policy that gives up on an event files one dead letter, even when the runner is cut short
between filing it and completing the event's inbox claim. The next delivery used to file a second
letter for the same failure, and retrying both ran the handler twice. A policy's dead letter now
has an id derived from the policy and the event, and is filed only if it is not there yet.
