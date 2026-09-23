---
"@bounda-dev/core": patch
---

`app.stop()` now makes every call wait for the same stop. A second call made while a stop was under
way used to return at once, before the storage was closed.
