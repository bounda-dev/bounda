---
"@bounda-dev/cli": patch
---

`bounda generate --watch` prints `watching app/ for changes` only once the watcher is listening.
It used to print the line first and start watching after, so a change saved as soon as the line
appeared could be missed.
