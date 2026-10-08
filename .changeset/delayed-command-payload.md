---
"@bounda-dev/core": patch
---

A scheduled command's payload is validated once before its handler sees it. The scheduler used to
store the payload already parsed and validate it again when the command ran, so a schema's
transform applied twice; it now stores the payload the caller passed, in the JSON form every
scheduler keeps, and a dead-letter retry of a dropped scheduled command gets the same payload.
Dispatch validates that JSON form, so a field JSON cannot carry fails at once instead of when the
command runs: a `z.date()` field in a scheduled command is rejected with "Invalid payload for scheduled
command"; declare it as `z.coerce.date()`. The payload no longer changes if the caller mutates the
object after dispatching it on the in-memory adapter.
