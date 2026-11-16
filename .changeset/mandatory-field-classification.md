---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"create-bounda": minor
---

Every field that can hold text is classified, or the app does not compile. `.bounda/types.ts` gains `<Aggregate>Classification`, which fails while a top-level field of an event's or a command's payload or of a process's state that can hold text (a non-literal string, a template literal, `unknown`, or anything containing one, record keys included) is marked neither `personal`, `person` nor `notPersonal`, or while a payload or a state holds text no mark reaches (not an object, or an object that keeps keys it does not declare); and `<ReadModel>Classification`, which fails while a `string` column, or a `json` one whose value can hold text, is marked neither `.personal()`, `.person()` nor `.notPersonal()`. Each message names the field. The app refuses to start on the same with `ConfigurationError`. Literals, enums, numbers, booleans, dates, `instant()` and `deadline()` need no mark, nor does a query's payload. `ClassifiesPayload`, `ClassifiesState`, `ClassifiesColumns` and `HoldsText` are exported for the generated checks.
