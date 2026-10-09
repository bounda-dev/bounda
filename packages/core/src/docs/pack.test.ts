import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GROUPS, packDocs, renderIndex } from "./pack.ts";

const SITE = "https://docs.bounda.dev";

const page = (title: string, order: number, body = "Body.\n") =>
  `---\ntitle: ${title}\ndescription: About ${title.toLowerCase()}.\nsidebar:\n  order: ${order}\n---\n\n${body}`;

let root: string;
let source: string;
let target: string;

const write = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(join(source, path)), { recursive: true });
  await writeFile(join(source, path), text);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bounda-docs-"));
  source = join(root, "content");
  target = join(root, "out");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("packDocs", () => {
  it("writes every page as Markdown with relative links, and an index in sidebar order", async () => {
    await write(
      "getting-started/index.md",
      page("Getting started", 0, "Then [test](/guides/testing/)."),
    );
    await write("guides/testing.md", page("Testing", 3));
    await write("guides/project-layout.md", page("Project layout", 0));
    await write("reference/cli.md", page("CLI", 0));

    const files = await packDocs({ source, target, version: "0.2.0", site: SITE });

    expect(files).toEqual([
      "README.md",
      "getting-started/index.md",
      "guides/project-layout.md",
      "guides/testing.md",
      "reference/cli.md",
    ]);
    expect(await readFile(join(target, "getting-started/index.md"), "utf8")).toBe(
      "# Getting started\n\nAbout getting started.\n\nThen [test](../guides/testing.md).",
    );
    const index = await readFile(join(target, "README.md"), "utf8");
    expect(index).toContain("Bounda 0.2.0");
    expect(index.indexOf("(./guides/project-layout.md)")).toBeLessThan(
      index.indexOf("(./guides/testing.md)"),
    );
    expect(index.indexOf("## Getting started")).toBeLessThan(index.indexOf("## Guides"));
    expect(index).not.toContain("## Examples");
  });

  it("replaces what an earlier pack left", async () => {
    await mkdir(join(target, "guides"), { recursive: true });
    await writeFile(join(target, "guides/removed.md"), "old");
    await write("guides/testing.md", page("Testing", 0));

    await packDocs({ source, target, version: "0.2.0", site: SITE });

    await expect(readFile(join(target, "guides/removed.md"), "utf8")).rejects.toThrow();
  });

  it("refuses a page outside a known group and a file that is not Markdown", async () => {
    await write("blog/launch.md", page("Launch", 0));
    await write("guides/diagram.svg", "<svg />");
    await write("guides/notes.mdx.bak", "old");

    await expect(packDocs({ source, target, version: "0.2.0", site: SITE })).rejects.toThrow(
      "docs outside a known group or not Markdown: blog/launch.md, guides/diagram.svg, guides/notes.mdx.bak",
    );
  });

  it("writes an MDX page as Markdown, and links to it as one", async () => {
    const tabs = [
      'import { TabItem, Tabs } from "@astrojs/starlight/components";',
      "",
      "<Tabs>",
      '  <TabItem label="SQLite">',
      "    Fast.",
      "  </TabItem>",
      "</Tabs>",
    ].join("\n");
    await write("guides/testing.mdx", page("Testing", 0, tabs));
    await write("guides/sagas.md", page("Sagas", 1, "See [testing](/guides/testing/)."));

    const files = await packDocs({ source, target, version: "0.2.0", site: SITE });

    expect(files).toEqual(["README.md", "guides/sagas.md", "guides/testing.md"]);
    expect(await readFile(join(target, "guides/testing.md"), "utf8")).toBe(
      "# Testing\n\nAbout testing.\n\n**SQLite**\n\nFast.\n",
    );
    expect(await readFile(join(target, "guides/sagas.md"), "utf8")).toContain("(./testing.md)");
  });

  it("leaves a Markdown page's prose alone even where it reads like MDX", async () => {
    await write("guides/sagas.md", page("Sagas", 0, "import the rest\n<Steps>\n"));

    await packDocs({ source, target, version: "0.2.0", site: SITE });

    expect(await readFile(join(target, "guides/sagas.md"), "utf8")).toContain(
      "import the rest\n<Steps>",
    );
  });
});

describe("renderIndex", () => {
  it("lists each group's pages by order, then by title, with their descriptions", () => {
    const pages = [
      { path: "guides/b.md", title: "B", description: "Second.", order: 1, body: "" },
      { path: "guides/c.md", title: "C", description: "Tied, later title.", order: 1, body: "" },
      { path: "guides/a.md", title: "Y", description: "First.", order: 0, body: "" },
      { path: "concepts/z.md", title: "Z", description: "Why.", order: 0, body: "" },
    ];
    expect(renderIndex({ pages, version: "1.2.3", site: SITE })).toBe(
      [
        "# Bounda documentation",
        "",
        "The documentation of Bounda 1.2.3, the version installed next to this file. Read it",
        `instead of guessing an API: it matches the code you run. ${SITE} serves the latest release.`,
        "",
        "## Guides",
        "",
        "- [Y](./guides/a.md): First.",
        "- [B](./guides/b.md): Second.",
        "- [C](./guides/c.md): Tied, later title.",
        "",
        "## Concepts",
        "",
        "- [Z](./concepts/z.md): Why.",
        "",
      ].join("\n"),
    );
  });
});

describe("GROUPS", () => {
  it("are the docs sidebar's autogenerated groups, in its order", async () => {
    const config = await readFile(
      fileURLToPath(new URL("../../../../docs/astro.config.mjs", import.meta.url)),
      "utf8",
    );
    const sidebar = [
      ...config.matchAll(
        /label: "([^"]+)", items: \[\{ autogenerate: \{ directory: "([^"]+)" \} \}\]/g,
      ),
    ].map(([, label, directory]) => ({ directory, label }));
    expect(GROUPS).toEqual(sidebar);
  });
});
