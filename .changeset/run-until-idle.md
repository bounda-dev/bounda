---
"@bounda-dev/core": minor
"@bounda-dev/cloudflare": patch
"create-bounda": patch
---

In an app from `createTestApp`, `app.runUntilIdle()` moves the fixed clock to each retry waiting
for its back-off, a policy's, a process handler's or a scheduled command's, until every failure
has gone through or given up as a dead letter. What falls due on the way runs in order, and the
clock goes no further than the last retry. A test of a provider that fails once no longer has to
know the back-off and advance the clock by it.

Breaking: `app.processUntilIdle()` is now `app.runUntilIdle()`, and its `ProcessUntilIdleOptions`
and `ProcessUntilIdleResult` types are `RunUntilIdleOptions` and `RunUntilIdleResult`.
