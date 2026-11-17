---
"@bounda-dev/core": minor
---

Every export is in the access log, even one nobody reads to the end or whose process dies on the way. `exportPersonalData` and `streamPersonalData` are recorded as `started` before anything is handed out, and again as they end, `ok`, `failed` or `cancelled`, both records with the same `detail.exportId`; a hook that fails on the start rejects the call with nothing handed out. `ExportAccess.outcome` is the new `ExportOutcome` (`started`, `ok`, `failed`, `cancelled`), and `AccessOutcome`, which every other record takes, is `ok` or `failed`.
