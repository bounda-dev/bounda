---
"@bounda-dev/react-router": patch
---

The `bounda()` plugin writes the paths of the registry and the configuration into the server
module with `/`, as Vite expects them on every platform, and recognises a change under
`app/domain` or `app/read` whatever separator the watcher reports, so it behaves the same on
Windows.
