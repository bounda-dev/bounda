import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

export default defineConfig({
  site: "https://bounda.dev",
  integrations: [
    starlight({
      title: "Bounda",
      favicon: "/favicon.svg",
      description: "Event sourcing and CQRS for TypeScript without the ceremony.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/bounda-dev/bounda" }],
      plugins: [starlightLlmsTxt()],
      sidebar: [
        { label: "Getting started", items: [{ autogenerate: { directory: "getting-started" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Adapters", items: [{ autogenerate: { directory: "adapters" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
      ],
    }),
  ],
});
