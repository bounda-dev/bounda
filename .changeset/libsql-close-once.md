---
"@bounda-dev/sqlite": patch
---

Close each libSQL connection once. libSQL's native module closes a connection a second time when nothing but its own handle holds it, reading freed memory, which on Windows could end the process with an access violation when storage or a read model on a file closed. The adapter now keeps a statement holding the connection across the close, so it is closed once, when collected.
