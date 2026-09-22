---
"@bounda-dev/core": patch
"@bounda-dev/adapter-sqlite": patch
"@bounda-dev/adapter-postgresql": patch
---

Advance checkpoints with `compareAndSet`. A dispatcher pass now moves a subscriber's checkpoint
only from the position it read; when another process, a rebuild or an operator moved it meanwhile,
the pass leaves their position alone and redelivers from there instead of overwriting it, which
could skip events without a trace. `CheckpointStore` gains `compareAndSet(subscriber, expected,
position)`; `set` stays for repositioning on purpose.
