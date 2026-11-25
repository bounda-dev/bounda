---
"@bounda-dev/core": patch
---

The worker logs a warning each time it finds a database file it is to encrypt, in the clear or under an earlier key, still held by another connection, naming the file and where it stands, so a file that stays readable is never left so silently between two tries.
