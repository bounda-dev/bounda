import { describe, expect, it } from "vitest";
import {
  pagePathOf,
  parsePage,
  renderAsides,
  renderComponents,
  renderPage,
  rewriteLinks,
} from "./markdown.ts";

const SITE = "https://docs.bounda.dev";
const pages = new Set(["getting-started/index.md", "guides/testing.md", "concepts/how-it-runs.md"]);

const page = (body: string, path = "guides/sagas.md") => ({
  path,
  title: "Sagas",
  description: "Steps that undo.",
  order: 2,
  body,
});

describe("parsePage", () => {
  it("reads the title, the description and the sidebar order, and keeps the body", () => {
    const source =
      "---\ntitle: Testing\ndescription: An app in memory.\nsidebar:\n  order: 3\n---\n\nBody.\n";
    expect(parsePage({ path: "guides/testing.md", source })).toEqual({
      path: "guides/testing.md",
      title: "Testing",
      description: "An app in memory.",
      order: 3,
      body: "\nBody.\n",
    });
  });

  it("unquotes a quoted title or description", () => {
    const source = `---\ntitle: 'It''s here'\ndescription: "Files: \\"where\\" they go."\n---\n`;
    const parsed = parsePage({ path: "guides/project-layout.md", source });
    expect([parsed.title, parsed.description]).toEqual(["It's here", 'Files: "where" they go.']);
  });

  it("trims a value and unquotes only a value quoted at both ends", () => {
    const source = [
      "---",
      'title: "Exactly once" per batch  ',
      'description: Read "how it runs" and the "outbox"',
      "---",
      "",
    ].join("\n");
    expect(parsePage({ path: "a.md", source })).toMatchObject({
      title: '"Exactly once" per batch',
      description: 'Read "how it runs" and the "outbox"',
    });
    const single = "---\ntitle: 'Quoted' then not\ndescription: not then 'quoted'\n---\n";
    expect(parsePage({ path: "a.md", source: single })).toMatchObject({
      title: "'Quoted' then not",
      description: "not then 'quoted'",
    });
  });

  it("reads the order only from sidebar's own line, as a whole number", () => {
    const nested = "---\ntitle: A\ndescription: B\nsidebar:\n  badge:\n    order: 9\n---\n";
    expect(parsePage({ path: "a.md", source: nested }).order).toBe(Number.POSITIVE_INFINITY);
    const odd = "---\ntitle: A\ndescription: B\nsidebar:\n  order: 1st\n---\n";
    expect(parsePage({ path: "a.md", source: odd }).order).toBe(Number.POSITIVE_INFINITY);
    const big = "---\ntitle: A\ndescription: B\nsidebar:\n  order: 12\n---\n";
    expect(parsePage({ path: "a.md", source: big }).order).toBe(12);
  });

  it("reads a value that only starts or ends with > or | as it is", () => {
    const source = "---\ntitle: Pipes |\ndescription: >= one line\n---\n";
    expect(parsePage({ path: "a.md", source })).toMatchObject({
      title: "Pipes |",
      description: ">= one line",
    });
  });

  it("refuses a multi-line title or description, which it cannot read", () => {
    const source = "---\ntitle: A\ndescription: >-\n  Folded\n  text.\n---\n";
    expect(() => parsePage({ path: "a.md", source })).toThrow(
      "a.md: description is a multi-line value; write it on one line",
    );
    expect(() =>
      parsePage({ path: "a.md", source: "---\ntitle: |\n  A\ndescription: B\n---\n" }),
    ).toThrow("a.md: title is a multi-line value; write it on one line");
  });

  it("sorts a page without an order last", () => {
    const source = "---\ntitle: CLI\ndescription: Commands.\n---\nBody";
    expect(parsePage({ path: "reference/cli.md", source }).order).toBe(Number.POSITIVE_INFINITY);
  });

  it("refuses a page without frontmatter, a title or a description", () => {
    expect(() => parsePage({ path: "a.md", source: "# A" })).toThrow("a.md: no frontmatter");
    expect(() => parsePage({ path: "a.md", source: "---\ntitle: A\n---\n" })).toThrow(
      "a.md: the frontmatter needs a title and a description",
    );
    expect(() => parsePage({ path: "a.md", source: "---\ndescription: A\n---\n" })).toThrow(
      "a.md: the frontmatter needs a title and a description",
    );
  });
});

describe("pagePathOf", () => {
  it("finds a page by its file or by the index of its directory", () => {
    expect(pagePathOf({ url: "/guides/testing/", pages })).toBe("guides/testing.md");
    expect(pagePathOf({ url: "/getting-started/", pages })).toBe("getting-started/index.md");
    expect(pagePathOf({ url: "/guides/missing/", pages })).toBeUndefined();
  });
});

describe("rewriteLinks", () => {
  it("points links to pages at their Markdown files, relative to the page, with the anchor", () => {
    const body =
      "See [testing](/guides/testing/#doubles), [how](/concepts/how-it-runs/) and [start](/getting-started/).";
    expect(rewriteLinks({ page: page(body), pages, site: SITE })).toBe(
      "See [testing](./testing.md#doubles), [how](../concepts/how-it-runs.md) and [start](../getting-started/index.md).",
    );
  });

  it("points static files at the site, in Markdown links and in HTML attributes", () => {
    const body = '![flow](/flow-light.svg)\n<img src="/flow-dark.svg" />\n<a href="/og.jpg">';
    expect(rewriteLinks({ page: page(body), pages, site: SITE })).toBe(
      `![flow](${SITE}/flow-light.svg)\n<img src="${SITE}/flow-dark.svg" />\n<a href="${SITE}/og.jpg">`,
    );
  });

  it("leaves external links and anchors on the same page alone", () => {
    const body = "[GitHub](https://github.com/bounda-dev/bounda) and [below](#doubles)";
    expect(rewriteLinks({ page: page(body), pages, site: SITE })).toBe(body);
  });

  it("points a link to the site's front page at the index the pack writes", () => {
    expect(rewriteLinks({ page: page("[the docs](/)"), pages, site: SITE })).toBe(
      "[the docs](../README.md)",
    );
  });

  it("leaves code samples as written", () => {
    const body = [
      "[testing](/guides/testing/)",
      "```tsx",
      '<a href="/orders">[back](/orders/)</a>',
      "```",
      "~~~~",
      "```",
      'src="/still-code"',
      "~~~~",
      "[how](/concepts/how-it-runs/)",
    ].join("\n");
    expect(rewriteLinks({ page: page(body), pages, site: SITE })).toBe(
      [
        "[testing](./testing.md)",
        "```tsx",
        '<a href="/orders">[back](/orders/)</a>',
        "```",
        "~~~~",
        "```",
        'src="/still-code"',
        "~~~~",
        "[how](../concepts/how-it-runs.md)",
      ].join("\n"),
    );
  });

  it("ends a code block only at a fence of its own kind and at least its length", () => {
    const body = [
      "First [link](/guides/testing/)",
      "and a second line.",
      "````md",
      "```",
      "~~~~",
      "[still code](/nowhere/)",
      "````",
      "[after](/guides/testing/)",
      "```",
      "[ends in code](/nowhere/)",
      "```",
    ].join("\n");
    expect(rewriteLinks({ page: page(body), pages, site: SITE })).toBe(
      [
        "First [link](./testing.md)",
        "and a second line.",
        "````md",
        "```",
        "~~~~",
        "[still code](/nowhere/)",
        "````",
        "[after](./testing.md)",
        "```",
        "[ends in code](/nowhere/)",
        "```",
      ].join("\n"),
    );
  });

  it("refuses a link to a page that does not exist", () => {
    expect(() => rewriteLinks({ page: page("[gone](/guides/gone/)"), pages, site: SITE })).toThrow(
      "guides/sagas.md: no page for the link /guides/gone/",
    );
  });
});

describe("renderAsides", () => {
  it("turns an aside into a blockquote headed by its kind and its title", () => {
    expect(renderAsides("Before.\n\n:::caution[0.x]\nIt can change.\n\nRead the log.\n:::\n")).toBe(
      "Before.\n\n> **Caution: 0.x**\n>\n> It can change.\n>\n> Read the log.\n",
    );
  });

  it("uses the kind alone when the aside has no title", () => {
    expect(renderAsides(":::tip\nCall outside first.\n:::")).toBe(
      "> **Tip**\n>\n> Call outside first.",
    );
  });

  it("keeps a code block inside an aside in the quote, and leaves ::: inside code alone", () => {
    const body = [
      ":::note",
      "Run it:",
      "```bash",
      ":::",
      "```",
      "Done.",
      ":::",
      "```md",
      ":::tip",
      "```",
    ].join("\n");
    expect(renderAsides(body)).toBe(
      [
        "> **Note**",
        ">",
        "> Run it:",
        "> ```bash",
        "> :::",
        "> ```",
        "> Done.",
        "```md",
        ":::tip",
        "```",
      ].join("\n"),
    );
  });

  it("closes an aside only outside its code, after a code block of several lines", () => {
    const body = [
      "::: not an aside",
      ":::tip",
      "```ts",
      "const a = 1;",
      ":::",
      "const b = 2;",
      "```",
      ":::",
      "After.",
      ":::note",
      "````",
      "```",
      "````",
      ":::",
    ].join("\n");
    expect(renderAsides(body)).toBe(
      [
        "::: not an aside",
        "> **Tip**",
        ">",
        "> ```ts",
        "> const a = 1;",
        "> :::",
        "> const b = 2;",
        "> ```",
        "After.",
        "> **Note**",
        ">",
        "> ````",
        "> ```",
        "> ````",
      ].join("\n"),
    );
  });

  it("leaves text without asides alone", () => {
    expect(renderAsides("A paragraph with ::: in it.")).toBe("A paragraph with ::: in it.");
  });
});

describe("renderComponents", () => {
  const render = (lines: readonly string[]) =>
    renderComponents({ path: "guides/testing.mdx", body: lines.join("\n") });

  it("drops Starlight's imports and the tags of Tabs, Steps and FileTree, keeping what they wrap", () => {
    expect(
      render([
        'import { FileTree, Steps } from "@astrojs/starlight/components";',
        "",
        "<Steps>",
        "",
        "1. Run it.",
        "",
        "</Steps>",
        "",
        "<FileTree>",
        "- app/",
        "  - main.ts",
        "</FileTree>",
      ]),
    ).toBe("\n\n1. Run it.\n\n- app/\n  - main.ts");
  });

  it("turns each tab into its label in bold over its content, unindented", () => {
    expect(
      render([
        '<Tabs syncKey="database">',
        '  <TabItem label="SQLite">',
        "    In memory.",
        "",
        "    ```ts",
        "    sqlite({ memory: true });",
        "      nested();",
        "    ```",
        "  </TabItem>",
        '  <TabItem label="PostgreSQL">',
        "    A container.",
        "  </TabItem>",
        "</Tabs>",
        "After.",
      ]),
    ).toBe(
      [
        "**SQLite**",
        "",
        "In memory.",
        "",
        "```ts",
        "sqlite({ memory: true });",
        "  nested();",
        "```",
        "",
        "**PostgreSQL**",
        "",
        "A container.",
        "",
        "After.",
      ].join("\n"),
    );
  });

  it("takes a tab's indentation from its first line with text", () => {
    expect(render(['<TabItem label="A">', "  ", "    Text.", "  </TabItem>"])).toBe(
      "**A**\n\nText.\n",
    );
  });

  it("refuses a tab without a label", () => {
    expect(() => render(["<TabItem>", "</TabItem>"])).toThrow(
      "guides/testing.mdx: a <TabItem> needs a label",
    );
  });

  it("leaves tags and imports inside code blocks as written", () => {
    const lines = ["```mdx", 'import { Card } from "./card";', "<Card />", "```"];
    expect(render(lines)).toBe(lines.join("\n"));
  });

  it("refuses any other component and any other import", () => {
    expect(() => render(['<Card title="A">', "</Card>"])).toThrow(
      "guides/testing.mdx: <Card> has no Markdown form; use Tabs, Steps or FileTree",
    );
    expect(() => render(["<Aside />"])).toThrow("<Aside> has no Markdown form");
    expect(() => render(['import { Card } from "./card";'])).toThrow(
      'guides/testing.mdx: cannot pack the import import { Card } from "./card";',
    );
  });
});

describe("renderPage", () => {
  it("heads the page with its title and description, then the rewritten body", () => {
    const body = "\n:::note\nSee [testing](/guides/testing/).\n:::\n";
    expect(renderPage({ page: page(body), pages, site: SITE })).toBe(
      "# Sagas\n\nSteps that undo.\n\n> **Note**\n>\n> See [testing](./testing.md).\n",
    );
  });
});
