---
"@bounda-dev/core": minor
---

A strict app's export checks for a restore once its header is read and once for each page that holds any records, after every key the page opens and before it hands out any of it, from inside the export rather than by counting calls to its stores. A header refused that way, and an export refused with `READ_MODEL_RESTORING` before it reads, are now in the access log as `failed`, as a refused page already was.
