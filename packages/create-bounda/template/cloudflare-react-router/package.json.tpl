{
  "name": "{{name}}",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.18"
  },
  "scripts": {
    "generate": "bounda generate && wrangler types && react-router typegen",
    "cf-typegen": "wrangler types",
    "dev": "react-router dev",
    "build": "react-router build",
    "preview": "react-router build && vite preview",
    "deploy": "react-router build && wrangler deploy",
    "typecheck": "bounda generate && wrangler types && react-router typegen && tsc --noEmit",
    "test": "bounda generate && vitest run"
  },
  "dependencies": {
    "@bounda-dev/cloudflare": "{{boundaVersion}}",
    "@bounda-dev/core": "{{boundaVersion}}",
    "@bounda-dev/react-router": "{{boundaVersion}}",
    "isbot": "{{isbotVersion}}",
    "react": "{{reactVersion}}",
    "react-dom": "{{reactVersion}}",
    "react-router": "{{reactRouterVersion}}"
  },
  "devDependencies": {
    "@bounda-dev/cli": "{{boundaVersion}}",
    "@cloudflare/vite-plugin": "{{cloudflareVitePluginVersion}}",
    "@cloudflare/vitest-plugin": "{{cloudflareVitestPluginVersion}}",
    "@react-router/dev": "{{reactRouterVersion}}",
    "@types/react": "{{typesReactVersion}}",
    "@types/react-dom": "{{typesReactVersion}}",
    "typescript": "{{typescriptVersion}}",
    "vite": "{{viteVersion}}",
    "vitest": "{{vitestVersion}}",
    "wrangler": "{{wranglerVersion}}"
  }
}
