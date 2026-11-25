---
"@bounda-dev/sqlite": minor
---

An app that bundles `@libsql/client` keeps its libSQL safeguards. The adapter used to reach libSQL's native module, `libsql`, only beside `@libsql/client`; in a bundle that took the client in, it lost the guard against closing a connection twice (which on Windows ends the process with an access violation) and the trial of an encrypted file's keys on its pages, without a word. It now also looks `libsql` up where the bundle's own code does, takes the copy already loaded when the two differ, and, when it finds none or it fails to load, emits one Node warning coded `BOUNDA_LIBSQL_NATIVE_MISSING` that says why and what is lost.
