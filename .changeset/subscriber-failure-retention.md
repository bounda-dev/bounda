---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"@bounda-dev/postgresql": minor
---

A subscriber's last failure no longer stays for good: once the subscriber got past it, or for a subscriber the app no longer runs once it last failed on it, the scheduled-command worker removes it, error text included, after `runtime.subscriberFailures.retention` (30 days by default, `DEFAULT_SUBSCRIBER_FAILURE_RETENTION_MS`). A failure whose text is sealed under a restricted person is kept until the restriction is lifted, unless its text no longer opens, its person forgotten since. `subscriberFailureRetentionContract` checks it on every storage adapter. `app.nextDueAt()` names when the purge comes due, `app.status()` reports it as `subscriberFailureRetention` and `bounda status` prints it; the record of processing states the retention. A tenant's forgetting removes every subscriber failure. Custom storage adapters implement `SubscriberFailureStore.remove`, which removes a failure only while it is as read and none of the persons it is told of is restricted, checked in the same step, and `clear`; `createSqlSubscriberFailureStore` takes the storage's `restrictions` table for it; `subscriberFailureStoreContract` now takes a storage with its `subscriberFailures` and `persons`.
