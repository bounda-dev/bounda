---
"@bounda-dev/cli": patch
---

`bounda generate --watch` no longer misses a change saved just after it starts. On macOS the file
system starts listening some time after the watch is set up and drops what changes before, so
the watch said it was listening when it was not. It now writes a cookie file,
`.bounda-watch-<uuid>`, into the application directory until it hears it back and removes it;
`--watch` makes its first run from then on. When the cookie has not come back after 20 writes, a
second, `--watch` warns that watching may miss changes, makes its first run and goes on watching.
