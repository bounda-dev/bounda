---
"@bounda-dev/react-router": patch
---

Keep the package out of Vite's server externals so the `bounda()` plugin serves
`@bounda-dev/react-router/app` when the package is installed from a registry. Vite matches
`noExternal` against the package, not the subpath, so a pattern for the subpath alone left the
real module to be loaded by Node, and every request failed with the "served by the bounda() Vite
plugin" error. A workspace link is never externalised, which is why the examples in this
repository worked.
