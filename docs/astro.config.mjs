import starlight from "@astrojs/starlight";
import { defineConfig, fontProviders } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";
import { basalt, bone } from "./src/code-themes.ts";

// The fonts of bounda.dev, self-hosted at build time with metric-matched fallbacks. Science Gothic
// is only ever set at 600, so it is requested at that one weight across the width axis it uses.
export default defineConfig({
  site: "https://docs.bounda.dev",
  fonts: [
    {
      provider: fontProviders.google(),
      name: "Science Gothic",
      cssVariable: "--font-science-gothic",
      weights: [600],
      styles: ["normal"],
      fallbacks: ["sans-serif"],
      options: { experimental: { variableAxis: { wdth: [["100", "125"]] } } },
    },
    {
      provider: fontProviders.google(),
      name: "IBM Plex Sans",
      cssVariable: "--font-ibm-plex-sans",
      weights: ["400 600"],
      styles: ["normal", "italic"],
      fallbacks: ["sans-serif"],
    },
    {
      provider: fontProviders.google(),
      name: "Red Hat Mono",
      cssVariable: "--font-red-hat-mono",
      weights: ["400 600"],
      styles: ["normal"],
      fallbacks: ["monospace"],
    },
  ],
  integrations: [
    starlight({
      title: "Bounda",
      favicon: "/favicon.svg",
      logo: {
        light: "./public/wordmark-light.svg",
        dark: "./public/wordmark-dark.svg",
        replacesTitle: true,
      },
      description: "Event sourcing and CQRS for TypeScript without the ceremony.",
      customCss: ["./src/styles/bounda.css"],
      components: { Head: "./src/components/Head.astro" },
      expressiveCode: {
        themes: [basalt, bone],
        styleOverrides: {
          borderRadius: "2px",
          codeFontFamily: "var(--sl-font-mono)",
          uiFontFamily: "var(--sl-font)",
          frames: { shadowColor: "transparent" },
        },
      },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/bounda-dev/bounda" }],
      plugins: [starlightLlmsTxt()],
      sidebar: [
        { label: "bounda.dev", link: "https://bounda.dev" },
        { label: "Getting started", items: [{ autogenerate: { directory: "getting-started" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        { label: "Adapters", items: [{ autogenerate: { directory: "adapters" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
      ],
    }),
  ],
});
