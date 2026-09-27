---
"@bounda-dev/cli": patch
---

`bounda generate --watch` no longer misses a change saved just after it starts. On macOS the file
system starts listening some time after the watch is set up and drops what changes before, so
`watchProject` said it was listening when it was not. It now writes a cookie file,
`.bounda-watch-<pid>-<n>`, into the application directory until it hears it back, removes it and
calls the new `onListening`; `--watch` makes its first run from then on.
