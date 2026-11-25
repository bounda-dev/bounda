---
"@bounda-dev/react-router": patch
---

Importing `@bounda-dev/react-router/app` without the `bounda()` Vite plugin fails before it loads `@bounda-dev/core` and `react-router`, which the helpers it re-exports need.
