import {
  definePlugin,
  type ExpressiveCodePlugin,
  type PostprocessRenderedBlockContext,
} from "@astrojs/starlight/expressive-code";

type Element = PostprocessRenderedBlockContext["renderData"]["blockAst"];
type Node = Element["children"][number];

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  json: "JSON",
  jsonc: "JSON",
  bash: "Shell",
  sh: "Shell",
  sql: "SQL",
};

const isElement = (node: Node): node is Element => node.type === "element";

const findHeader = (node: Element): Element | undefined => {
  if (node.tagName === "figcaption") return node;
  for (const child of node.children.filter(isElement)) {
    const found = findHeader(child);
    if (found) return found;
  }
  return undefined;
};

// The selectors repeat Expressive Code's own, so these rules, which come after them, win.
const baseStyles = `
  .frame .header,
  .frame.has-title:not(.is-terminal) .header,
  .frame.is-terminal .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    min-height: 2.5rem;
    padding: 0 3.25rem 0 0.875rem;
    border-bottom: 1px solid var(--sl-color-hairline);
    background: var(--sl-color-gray-6);
  }

  .frame.is-terminal .header::before,
  .frame.has-title:not(.is-terminal) .title::after {
    display: none;
  }

  .frame.has-title:not(.is-terminal) .title,
  .frame.is-terminal .title {
    padding: 0;
    border: 0;
    background: none;
    color: var(--sl-color-gray-3);
  }

  .bounda-code-language {
    margin-inline-start: auto;
    font-family: var(--bounda-display);
    font-weight: 600;
    font-stretch: 125%;
    font-size: 0.625rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--sl-color-gray-3);
  }

  .copy {
    inset-block-start: 0.25rem;
  }
`;

// Every block gets a header, as a ledger gets a heading: the file on the left, the language on
// the right, so a block without a title still says what it is.
export const codeHeader = (): ExpressiveCodePlugin =>
  definePlugin({
    name: "bounda-code-header",
    baseStyles,
    hooks: {
      postprocessRenderedBlock: ({ codeBlock, renderData }) => {
        const header = findHeader(renderData.blockAst);
        const language = LANGUAGES[codeBlock.language];
        if (!header || !language) return;
        header.children.push({
          type: "element",
          tagName: "span",
          properties: { className: ["bounda-code-language"] },
          children: [{ type: "text", value: language }],
        });
      },
    },
  });
