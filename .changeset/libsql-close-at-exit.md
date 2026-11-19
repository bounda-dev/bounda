---
"@bounda-dev/sqlite": patch
---

Close each libSQL connection once also when the process exits with it open, such as a script that ends without stopping its app: the process collects every handle left as it exits, and libSQL's native module closed such a connection twice, which on Windows could end the process with an access violation instead of its own exit code.
