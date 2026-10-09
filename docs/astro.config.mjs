import starlight from "@astrojs/starlight";
import { defineConfig, fontProviders } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightPageActions from "starlight-page-actions";
import { codeHeader } from "./src/code-header.ts";
import { basalt, bone } from "./src/code-themes.ts";
import { DESCRIPTION, SITE, socialImage } from "./src/site.ts";

// The fonts of bounda.dev, self-hosted at build time with metric-matched fallbacks. Science Gothic
// is only ever set at 600, so it is requested at that one weight across the width axis it uses.
export default defineConfig({
  site: SITE,
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
      head: socialImage(`${SITE}/og.jpg`),
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
        Search: "./src/components/Search.astro",
      },
      expressiveCode: {
        themes: [basalt, bone],
        plugins: [codeHeader()],
        styleOverrides: {
          borderRadius: "2px",
          borderColor: "var(--sl-color-hairline)",
          codeFontFamily: "var(--sl-font-mono)",
          codeFontSize: "0.8125rem",
          uiFontFamily: "var(--sl-font-mono)",
          uiFontSize: "0.75rem",
          // One header for every frame, the editor's and the terminal's alike: no tab, no window
          // dots, a hairline under it.
          frames: {
            shadowColor: "transparent",
            frameBoxShadowCssValue: "none",
            editorTabBarBackground: "var(--sl-color-gray-6)",
            editorTabBarBorderBottomColor: "var(--sl-color-hairline)",
            editorActiveTabBackground: "transparent",
            editorActiveTabForeground: "var(--sl-color-gray-3)",
            editorActiveTabBorderColor: "transparent",
            editorActiveTabIndicatorTopColor: "transparent",
            editorActiveTabIndicatorBottomColor: "transparent",
            editorTabBorderRadius: "0",
            editorTabsMarginInlineStart: "0",
            editorTabsMarginBlockStart: "0",
            terminalTitlebarBackground: "var(--sl-color-gray-6)",
            terminalTitlebarForeground: "var(--sl-color-gray-3)",
            terminalTitlebarBorderBottomColor: "var(--sl-color-hairline)",
            terminalTitlebarDotsOpacity: "0",
            inlineButtonBorderOpacity: "0",
          },
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
