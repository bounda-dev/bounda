import starlight from "@astrojs/starlight";
import { defineConfig, fontProviders } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightPageActions from "starlight-page-actions";
import { basalt, bone } from "./src/code-themes.ts";
import { DESCRIPTION, socialImage } from "./src/site.ts";

// The fonts of bounda.dev, self-hosted at build time with metric-matched fallbacks. Science Gothic
// is only ever set at 600, so it is requested at that one weight across the width axis it uses.
export default defineConfig({
  site: "https://docs.bounda.dev",
  // Pages that moved keep their old address working, since links to them live outside the docs.
  redirects: {
    "/guides/how-it-runs/": "/concepts/how-it-runs/",
    "/guides/storefront-example/": "/examples/storefront/",
    "/guides/onboarding-example/": "/examples/onboarding/",
  },
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
      description: DESCRIPTION,
      customCss: ["./src/styles/bounda.css"],
      head: socialImage("https://docs.bounda.dev/og.jpg"),
      routeMiddleware: "./src/route-data.ts",
      components: {
        Head: "./src/components/Head.astro",
        PageTitle: "./src/components/PageTitle.astro",
        Pagination: "./src/components/Pagination.astro",
        Sidebar: "./src/components/Sidebar.astro",
        TableOfContents: "./src/components/TableOfContents.astro",
        Footer: "./src/components/Footer.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
        SocialIcons: "./src/components/SocialIcons.astro",
        MobileMenuToggle: "./src/components/MobileMenuToggle.astro",
      },
      expressiveCode: {
        themes: [basalt, bone],
        styleOverrides: {
          borderRadius: "2px",
          codeFontFamily: "var(--sl-font-mono)",
          uiFontFamily: "var(--sl-font)",
          frames: { shadowColor: "transparent" },
        },
      },
      // No `baseUrl` for the page actions: with one they write their own llms.txt over
      // starlight-llms-txt's.
      plugins: [
        starlightLlmsTxt(),
        starlightPageActions({
          prompt: "Read {url}, a page of the Bounda docs, so I can ask about it.",
          actions: {
            chatgpt: true,
            claude: true,
            markdown: true,
            t3chat: false,
            v0: false,
            cursor: false,
            perplexity: false,
            githubCopilot: false,
          },
        }),
      ],
      sidebar: [
        { label: "Getting started", items: [{ autogenerate: { directory: "getting-started" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Examples", items: [{ autogenerate: { directory: "examples" } }] },
        { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        { label: "Adapters", items: [{ autogenerate: { directory: "adapters" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
      ],
    }),
  ],
});
