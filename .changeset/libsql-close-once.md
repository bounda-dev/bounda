---
"@bounda-dev/sqlite": patch
"@bounda-dev/core": patch
---

Close each libSQL connection once. libSQL's native module closes a connection a second time when nothing but its own handle holds it, whether the database is closed or collected unclosed, and the second close reads freed memory: on Windows that could end the process with an access violation. The adapter now keeps a statement holding the connection across a close, and closes a database dropped without one the same way before it is collected, so each connection is closed once. On Windows a closed database's file can stay locked until the process lets go of it: replace a file only with the app stopped, or restore in place through SQL. The restore contract gives each case more time on slow disks.
