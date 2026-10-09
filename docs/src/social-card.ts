import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import wordmark from "../public/wordmark-dark.svg?raw";

// The card a docs page shows when it is shared, drawn at build in Basalt: the lockup, the page's
// group as a label, its title and description, and the ⅃ closing the card.

const WIDTH = 1200;
const HEIGHT = 630;
// What fits in two lines of the description at its size; longer ones end in an ellipsis.
const DESCRIPTION_LENGTH = 120;

const shorten = (text: string): string => {
  if (text.length <= DESCRIPTION_LENGTH) return text;
  const cut = text.slice(0, DESCRIPTION_LENGTH);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:.]$/, "")}…`;
};

const BASALT = {
  bg: "#121314",
  rule: "#2E2F32",
  text: "#E6E0D3",
  muted: "#9C978C",
  accent: "#D9A04A",
};

const require = createRequire(import.meta.url);
const font = (file: string) => readFile(require.resolve(file));

const fonts = Promise.all([
  font("@fontsource/science-gothic/files/science-gothic-latin-600-normal.woff"),
  font("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff"),
  font("@fontsource/red-hat-mono/files/red-hat-mono-latin-400-normal.woff"),
]).then(([display, text, mono]) => [
  { name: "Science Gothic", data: display, weight: 600 as const, style: "normal" as const },
  { name: "IBM Plex Sans", data: text, weight: 400 as const, style: "normal" as const },
  { name: "Red Hat Mono", data: mono, weight: 400 as const, style: "normal" as const },
]);

const lockup = `data:image/svg+xml;base64,${Buffer.from(wordmark).toString("base64")}`;

const CLOSE = `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 35 65"><path fill="${BASALT.text}" d="M25 0h10v65H25v-8H0v-6h25z"/></svg>`,
).toString("base64")}`;

interface Node {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>> & { readonly children?: unknown };
}

const node = (type: string, style: object, children?: unknown, props: object = {}): Node => ({
  type,
  props: { ...props, style, children },
});

export interface SocialCardArgs {
  readonly group: string | undefined;
  readonly title: string;
  readonly description: string | undefined;
  readonly site: string;
}

export interface SocialCardFunction {
  (args: SocialCardArgs): Promise<Uint8Array<ArrayBuffer>>;
}

export const socialCard: SocialCardFunction = async ({ group, title, description, site }) => {
  const card = node(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      width: WIDTH,
      height: HEIGHT,
      padding: "56px 72px 48px",
      background: BASALT.bg,
      color: BASALT.text,
      fontFamily: "IBM Plex Sans",
    },
    [
      node("div", { display: "flex", justifyContent: "space-between", alignItems: "center" }, [
        node("img", { height: 40 }, undefined, { src: lockup, width: 219, height: 40 }),
        node(
          "div",
          { fontFamily: "Red Hat Mono", fontSize: 24, color: BASALT.muted },
          new URL(site).host,
        ),
      ]),
      node("div", { display: "flex", flexDirection: "column", marginTop: "auto" }, [
        group
          ? node(
              "div",
              {
                fontFamily: "Science Gothic",
                fontSize: 22,
                letterSpacing: 3,
                textTransform: "uppercase",
                color: BASALT.accent,
              },
              group,
            )
          : null,
        node(
          "div",
          {
            marginTop: 16,
            fontFamily: "Science Gothic",
            fontSize: title.length > 32 ? 60 : 72,
            lineHeight: 1.08,
            letterSpacing: -0.5,
          },
          title,
        ),
        description
          ? node(
              "div",
              {
                marginTop: 24,
                maxWidth: 940,
                fontSize: 28,
                lineHeight: 1.4,
                color: BASALT.muted,
              },
              shorten(description),
            )
          : null,
      ]),
      node(
        "div",
        {
          display: "flex",
          justifyContent: "flex-end",
          marginTop: 40,
          paddingTop: 24,
          borderTop: `1px solid ${BASALT.rule}`,
        },
        node("img", {}, undefined, { src: CLOSE, width: 19, height: 36 }),
      ),
    ],
  );
  const svg = await satori(card as Parameters<typeof satori>[0], {
    width: WIDTH,
    height: HEIGHT,
    fonts: await fonts,
  });
  return new Uint8Array(
    new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } }).render().asPng(),
  );
};
