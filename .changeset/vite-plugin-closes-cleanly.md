---
"@bounda-dev/react-router": patch
---

Closing the dev server now waits for a regeneration the `bounda()` Vite plugin is running, and
drops one still waiting for its quiet time. It used to let both go on, so the generator could
write to the project after the server had closed.
