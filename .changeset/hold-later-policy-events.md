---
"@bounda-dev/core": patch
---

A policy no longer runs its later events while an earlier one is held. When a policy's event was
waiting for a retry, or another instance held its claim, the runner still ran the policy's later
events of the same batch, so they overtook the held one. The policy now skips the rest of the
batch until the held event is done, as the process runner does; other policies carry on.
