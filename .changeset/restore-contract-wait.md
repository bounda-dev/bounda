---
"@bounda-dev/core": patch
---

The restore contract in `@bounda-dev/core/adapter/testing` gives the instance that runs no worker as long as a slow runner or a shared server needs to find a restore, instead of one second.
