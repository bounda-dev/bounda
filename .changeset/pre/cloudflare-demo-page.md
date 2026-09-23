---
"create-bounda": patch
---

A Cloudflare project serves `public/index.html` as a static asset: a page that places orders and
lists them through the API, so a fresh deploy shows something that works. It also gets a `build`
script, which Workers Builds and the Deploy to Cloudflare button run before deploying.
