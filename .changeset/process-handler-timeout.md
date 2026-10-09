---
"@bounda-dev/core": minor
---

Process handlers, for an event or a deadline, have their own time limit,
`runtime.processes.handlerTimeout` (default `"30s"`, and per aggregate under `overrides`). Their
claim on an event lasts twice as long, and the scheduled-command worker's lease covers it.
`runtime.processes.timeout` is still how long a process stays open.

Breaking: `runtime.policies.timeout`, and an override's `policies.timeout`, bound policies only.
An app that set them for its processes, longer or shorter, sets `processes.handlerTimeout` there
too; otherwise its process handlers get 30 seconds.
