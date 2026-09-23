---
"@bounda-dev/cli": minor
---

`watchProject` takes an optional `clock`, the `Clock` from `@bounda-dev/core` that its quiet time is
measured on. It defaults to the wall clock, so nothing changes unless you pass one; with
`createFixedClock()` a test decides when a burst of changes goes to `onChange`.
