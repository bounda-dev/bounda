---
"@bounda-dev/core": minor
"@bounda-dev/react-router": minor
---

`react-router build` now bundles `bounda.config.ts` into the server build, next to the registry,
and the built app reads `.env` from the directory it runs in. It used to keep the absolute path of
the machine that built it, so a build deployed anywhere else answered every request with a 500,
and it imported the configuration at runtime, so the file had to be shipped beside the build. In
development an edited `bounda.config.ts` now reboots the app on the next request, and the
generator runs once per build instead of once per environment.

`boot()` and `loadProject()` take `importConfig`, a function that imports the configuration
module after `.env` is loaded, for a bundler that has to see the import. `APP_MODULE_ID` is no
longer exported from `@bounda-dev/react-router`.
