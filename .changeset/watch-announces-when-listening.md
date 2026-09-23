---
"@bounda-dev/cli": patch
---

`bounda generate --watch` starts watching before its first run instead of after it, so a module
saved while that run is going is regenerated right after it rather than at the next change. It
prints `watching app/ for changes` once the watcher is listening; it used to print the line first
and start watching after.
