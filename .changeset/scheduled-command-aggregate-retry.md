---
"@bounda-dev/core": patch
---

A command scheduled with `delay` is retried with the `policies.retry` of its aggregate, so `runtime.overrides.<aggregate>.policies.retry` applies to it as it does to that aggregate's policies. It used to take `runtime.policies.retry` whatever its aggregate.
