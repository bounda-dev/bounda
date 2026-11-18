---
"@bounda-dev/core": patch
---

`eventStoreContract` also checks that `reseal` writes any JSON payload, a top-level boolean or an array of booleans included, as `append` does.
