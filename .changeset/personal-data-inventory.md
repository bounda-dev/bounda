---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"create-bounda": minor
---

Print the record of processing activities of article 30 of the GDPR with `bounda personal-data inventory` (text, `--json` or `--markdown`): every category with its basis and retention, every event, command, process state and read model that holds personal data, whose, how it is sealed and where its copies go, every recipient, what the runtime keeps about persons and for how long, and the keys configured. It exits 1 while a field that can hold text is left unclassified, an unmarked field is named like personal data, text sits where no mark reaches, personal fields have no legal basis or logs carry error text. `personalDataInventory` in `@bounda-dev/core` returns the same record.

`notPersonal(schema)`, next to `personal` and `person` in the arguments of an event's or a command's `payload` and of a process's `state`, and `.notPersonal()` on a read-model column mark a field that holds no personal data; a field takes one of the three marks. New projects declare a category for their delivery note and classify every field.
