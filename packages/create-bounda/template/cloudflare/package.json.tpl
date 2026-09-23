{
  "name": "{{name}}",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.18"
  },
  "scripts": {
    "generate": "bounda generate",
    "cf-typegen": "wrangler types",
    "build": "bounda generate",
    "dev": "bounda generate && wrangler types && wrangler dev",
    "deploy": "bounda generate && wrangler deploy",
    "typecheck": "bounda generate && wrangler types && tsc --noEmit",
    "check": "bounda generate && wrangler types && tsc --noEmit && wrangler deploy --dry-run",
    "test": "bounda generate && vitest run"
  },
  "dependencies": {
    "@bounda-dev/adapter-cloudflare": "{{boundaVersion}}",
    "@bounda-dev/core": "{{boundaVersion}}"
  },
  "devDependencies": {
    "@bounda-dev/cli": "{{boundaVersion}}",
    "@cloudflare/vitest-plugin": "{{cloudflareVitestPluginVersion}}",
    "typescript": "{{typescriptVersion}}",
    "vitest": "{{cloudflareVitestVersion}}",
    "wrangler": "{{wranglerVersion}}"
  }
}
