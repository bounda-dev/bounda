---
"@bounda-dev/sqlite": patch
---

An app that starts while another process holds its libSQL file, in the clear or under an earlier key, now encrypts it as soon as that process lets go. Before, the keys it tried on the file and that did not open it could keep the file's WAL open, and with it a lock that refused the encryption, until a garbage collection, which a quiet process may not run for long: the file stayed readable, and `forgetTenant` refused, meanwhile. The keys are now tried first through a connection that takes no lock and leaves the WAL alone, and the file itself is opened only under the key that reads it.
