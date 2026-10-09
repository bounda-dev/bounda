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
    "dev": "react-router dev",
    "build": "react-router build",
    "start": "react-router-serve ./build/server/index.js",
    "typecheck": "react-router typegen && tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@bounda-dev/core": "{{boundaVersion}}",
    "@bounda-dev/react-router": "{{boundaVersion}}",
    "{{adapterPackage}}": "{{boundaVersion}}",
    "@react-router/node": "{{reactRouterVersion}}",
    "@react-router/serve": "{{reactRouterVersion}}",
    "isbot": "{{isbotVersion}}",
    "react": "{{reactVersion}}",
    "react-dom": "{{reactVersion}}",
    "react-router": "{{reactRouterVersion}}"
  },
  "devDependencies": {
    "@bounda-dev/cli": "{{boundaVersion}}",
    "@react-router/dev": "{{reactRouterVersion}}",
    "@types/node": "{{typesNodeVersion}}",
    "@types/react": "{{typesReactVersion}}",
    "@types/react-dom": "{{typesReactVersion}}",
    "typescript": "{{typescriptVersion}}",
    "vite": "{{viteVersion}}",
    "vitest": "{{vitestVersion}}"
  }
}
