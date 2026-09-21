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
    "dev": "bounda generate --watch",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "start": "node src/main.ts"
  },
  "dependencies": {
    "@bounda-dev/core": "{{boundaVersion}}",
    "{{adapterPackage}}": "{{boundaVersion}}"
  },
  "devDependencies": {
    "@bounda-dev/cli": "{{boundaVersion}}",
    "@types/node": "{{typesNodeVersion}}",
    "typescript": "{{typescriptVersion}}",
    "vitest": "{{vitestVersion}}"
  }
}
