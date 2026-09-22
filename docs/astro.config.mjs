import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

export default defineConfig({
  site: "https://docs.bounda.dev",
  integrations: [
    starlight({
      title: "Bounda",
      favicon: "/favicon.svg",
      logo: {
        light: "./src/assets/wordmark-light.svg",
        dark: "./src/assets/wordmark-dark.svg",
        replacesTitle: true,
      },
      description: "Event sourcing and CQRS for TypeScript without the ceremony.",
      customCss: ["./src/styles/bounda.css"],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/bounda-dev/bounda" }],
      plugins: [starlightLlmsTxt()],
      sidebar: [
        { label: "bounda.dev", link: "https://bounda.dev" },
        { label: "Getting started", items: [{ autogenerate: { directory: "getting-started" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Adapters", items: [{ autogenerate: { directory: "adapters" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
      ],
    }),
  ],
});
