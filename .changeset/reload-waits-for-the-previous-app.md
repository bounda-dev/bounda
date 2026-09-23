---
"@bounda-dev/react-router": patch
---

When `createBounda` is called again in development, the next request boots the new app only once
the one booted before has stopped. It used to boot at once while the previous app was still
closing, so for a moment both held the storage. `dispose()` now resolves once every app booted
under its key has stopped, including one a later `createBounda` is still stopping.
