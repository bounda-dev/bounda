---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

A port says whose personal data its calls return, and a raw read whose rows it read: text built from them is sealed under those persons too (articles 15(4), 17, 15(1) and 18).

- A port module exports `returnsPersonalData`, typed `Port.ReturnsPersonalData`: `false`, or per method (for a port that is a function, for its calls) `false` or `{ persons, personsOnError?, categories? }`. Each call then counts as a read of those persons' data of those categories, under the key they hold, created when they hold none: a dead letter's, a subscriber failure's or a remembered rejection's text is encrypted under their keys, listed in their export, withheld from anyone else's, unreadable once they are forgotten and covered by their restriction; a restricted person throws `ProcessingRestrictedError` from the call unless the run names a basis; a later call to a recipient records the data as disclosed; a query's access record names them.
- Breaking: `.bounda/types.ts` fails to compile at `<Module>PortReturns` while a port answers what can hold text and its module does not export `returnsPersonalData`; declare `false` for a port whose calls return nobody's data. The generator writes `+types/<port>.ts` for every port.
- `client.rawReadOf(persons, { categories })` says whose data a read through `client.raw` returned, in a projection (its failure's text is sealed under them) and in a query (the access log names them, a restricted one is refused).
- The app refuses to start, with `ConfigurationError`, on a declaration that is not `false` or an object, lacks a `persons` function, or names categories the app does not have.
