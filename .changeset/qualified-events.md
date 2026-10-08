---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

An event is now identified by its aggregate and its type, so two aggregates may name an event the
same and a handler that reacts to one never sees the other. Policies, processes, projections and
read-your-writes route by `(aggregate, type)`; before, a policy or projection reacted to every
event with its type name, whichever aggregate it came from.

The layout follows one rule: a file refers to the events of the aggregate it sits in, and a folder
named after another aggregate holds what reacts to that aggregate's events.

- A policy can react to another aggregate's events from `policies/<aggregate>/`; its key carries
  the aggregate (`paymentRefundOnPaymentFailed`) and its event is typed against that aggregate.
- Projections move to `projections/<aggregate>/<event>.ts`. `bounda generate` rejects a projection
  outside such a folder, a folder that is not an aggregate, a policy named after an aggregate and
  an aggregate's folder of its own policies.
- A policy whose trigger is not an event of the aggregate it listens to now fails at boot instead
  of never running.

Breaking: move every projection into the folder of its aggregate and run `bounda generate`. A
hand-written registry groups `projections` by aggregate (`projections.order.orderPlaced`), and a
policy for another aggregate's events sets `source`. `DispatchResult` carries `aggregateType`.
Projection names in logs and traces read `order.orderPlaced`, and a read model's
fingerprint changes, so a rebuild paused before the upgrade starts again.
