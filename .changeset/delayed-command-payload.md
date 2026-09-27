---
"@bounda-dev/core": patch
---

A delayed command's payload is validated once before its handler sees it. The scheduler used to
store the payload already parsed and validate it again when the command ran, so a schema's
transform applied twice; it now stores the payload as the caller passed it, still validating it
at dispatch to reject bad input at once. A dead-letter replay of a dropped delayed command gets
the same payload.
