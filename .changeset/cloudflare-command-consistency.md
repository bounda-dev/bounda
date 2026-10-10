---
"@bounda-dev/cloudflare": patch
---

A Bounda object's `command` reads a missing `consistency` as `"read-your-writes"` without
spelling the default out: no change in behaviour.
