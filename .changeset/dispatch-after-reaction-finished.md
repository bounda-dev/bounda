---
"@bounda-dev/core": patch
---

A command a policy or process handler dispatches once its run has finished, from a timer or a promise the handler left behind, is now refused with `REACTION_FINISHED` and logged at `error`. It used to resolve as if decided while its events went into a unit of work that was already committed, or about to be, so they were lost, or stored only when the dispatch happened to land before the commit.
