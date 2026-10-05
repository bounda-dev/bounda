---
"@bounda-dev/core": patch
---

In an app from `createTestApp`, `app.runUntilIdle()` no longer moves the clock to a retry that no
longer waits. It remembered every retry reported to it until the clock reached it, so a retry made
moot, a process deadline the process moved meanwhile or an event for an instance that ended, still
moved the clock and ran what was scheduled on the way, which the test had never advanced to. It
now counts, every round, the reactions that still wait and the scheduled commands still stored for
a retry. A retry without back-off no longer costs an extra round once it has run. The contracts of
`runUntilIdle`, its options and its result, and the testing guide, say what the clock does and that
nothing else may run on the app meanwhile.
