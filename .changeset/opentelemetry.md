---
"@bounda-dev/core": patch
---

OpenTelemetry. `@bounda-dev/core` depends on `@opentelemetry/api` and instruments the runtime:
spans for every command dispatch, every batch the dispatcher hands to a subscriber, every
projection, policy and process handler run, and every scheduled command the worker executes, all
carrying `bounda.correlation_id`; an observable gauge `bounda.dispatcher.lag` per subscriber and
counters `bounda.commands` and `bounda.dead_letters`. Without an SDK registered the API is a
no-op; register one before `boot()` and everything shows up under the scope `@bounda-dev/core`.
