---
"@bounda-dev/core": minor
"@bounda-dev/postgresql": patch
---

A read model's table is now `<prefix>rm_<read_model>` (`bounda_rm_order_summary`), apart from the
storage tables. A read model named `events`, `checkpoints`, `inbox`, `deadLetters` or
`scheduledCommands` used to open the storage table of that name: booting refused it as a destructive
change and suggested `bounda rebuild`, which then dropped the event store. Hand-written SQL that
names a read model's table needs the new name.
