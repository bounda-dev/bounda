---
"@bounda-dev/core": minor
"@bounda-dev/adapter-cloudflare": patch
"create-bounda": patch
---

In an app from `createTestApp`, `app.runUntilIdle()` moves the fixed clock to each retry waiting
for its back-off, a policy's, a process handler's or a scheduled command's, until every failure
has gone through or given up as a dead letter. A test of a provider that fails once no longer has
to know the back-off and advance the clock by it; nothing else moves the clock on its own.

Breaking: `app.processUntilIdle()` is now `app.runUntilIdle()`, and its `ProcessUntilIdleOptions`
and `ProcessUntilIdleResult` types are `RunUntilIdleOptions` and `RunUntilIdleResult`.
