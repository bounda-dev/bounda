{
  "name": "{{name}}",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.18"
  },
  "scripts": {
    "prepare": "bounda generate",
    "generate": "bounda generate",
    "build": "bounda generate",
    "dev": "bounda generate && wrangler dev",
    "deploy": "bounda generate && wrangler deploy",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@bounda-dev/adapter-cloudflare": "{{boundaVersion}}",
    "@bounda-dev/core": "{{boundaVersion}}"
  },
  "devDependencies": {
    "@bounda-dev/cli": "{{boundaVersion}}",
    "@cloudflare/workers-types": "{{workersTypesVersion}}",
    "typescript": "{{typescriptVersion}}",
    "vitest": "{{vitestVersion}}",
    "wrangler": "{{wranglerVersion}}"
  }
}
