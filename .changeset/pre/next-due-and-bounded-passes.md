---
"@bounda-dev/core": patch
"@bounda-dev/adapter-sqlite": patch
"@bounda-dev/adapter-postgresql": patch
---

Drive the runtime from a host without a background loop. `app.processUntilIdle({ maxPasses })`
stops after that many rounds and resolves to `{ idle }`; `app.nextDueAt()` is the earliest moment
a scheduled command or a process time-out becomes due. `Scheduler` gains `nextDueAt({ leaseMs })`,
which counts the lease of a claimed command, in every adapter.
