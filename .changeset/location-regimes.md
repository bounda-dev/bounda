---
"@bounda-dev/core": minor
"@bounda-dev/cloudflare": minor
---

Compare data locations by the legal regime each is under for chapter V of the GDPR, not as written. A `location` is now a `DataLocation`: a country by its ISO 3166-1 alpha-2 code in lower case, such as `"de"`, or one of `"eu"`, `"eea"`, `"fedramp"`, `"fedramp-high"` and `"global"`; any other value is refused at boot. `regimeOf` maps each to the European Economic Area, a country or, for `"global"`, none, so a store in `"de"` under a storage in `"eu"`, or in `"fedramp"` under one in `"us"`, needs no safeguard, while one under another regime does. `adequacy` is taken only where an adequacy decision covers the location (`ADEQUATE_COUNTRIES`, `AdequateLocation`), for stores and recipients alike, and recipients in the Åland Islands and the outermost regions of France count as inside the European Economic Area. `checkPlacement` in `@bounda-dev/core/adapter` judges one store as every runtime does at boot. On Cloudflare, `cloudflare({ jurisdiction })` and the keepers take only Cloudflare's Durable Object jurisdictions, and a Workers KV store's location is `"global"`, under a safeguard other than `adequacy`.
