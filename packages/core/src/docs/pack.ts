import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { INDEX, type Page, parsePage, renderComponents, renderPage } from "./markdown.ts";

// The sidebar's groups, in its order (`docs/astro.config.mjs`). A directory missing here fails the
// pack, so a new group cannot ship without a place in the index.
export const GROUPS: readonly { readonly directory: string; readonly label: string }[] = [
  { directory: "getting-started", label: "Getting started" },
  { directory: "guides", label: "Guides" },
  { directory: "examples", label: "Examples" },
  { directory: "concepts", label: "Concepts" },
  { directory: "adapters", label: "Adapters" },
  { directory: "reference", label: "Reference" },
];

export interface RenderIndexArgs {
  readonly pages: readonly Page[];
  readonly version: string;
  readonly site: string;
}

export interface RenderIndexFunction {
  (args: RenderIndexArgs): string;
}

export const renderIndex: RenderIndexFunction = ({ pages, version, site }) => {
  const sections = GROUPS.flatMap(({ directory, label }) => {
    const group = pages
      .filter((page) => page.path.startsWith(`${directory}/`))
      .toSorted((a, b) => a.order - b.order || a.title.localeCompare(b.title, "en"));
    if (group.length === 0) return [];
    const items = group.map((page) => `- [${page.title}](./${page.path}): ${page.description}`);
    return [`## ${label}`, "", ...items, ""];
  });
  return [
    "# Bounda documentation",
    "",
    `The documentation of Bounda ${version}, the version installed next to this file. Read it`,
    `instead of guessing an API: it matches the code you run. ${site} serves the latest release.`,
    "",
    ...sections,
  ].join("\n");
};

export interface PackDocsArgs {
  // Starlight's content directory, `docs/src/content/docs`.
  readonly source: string;
  readonly target: string;
  readonly version: string;
  readonly site: string;
}

export interface PackDocsFunction {
  (args: PackDocsArgs): Promise<readonly string[]>;
}

const walk = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .toSorted();
};

// The site's front page (`index.mdx`) is a splash of components; the generated README takes its
// place.
const isFrontPage = (path: string): boolean => path === "index.mdx";

const outputOf = (path: string): string => path.replace(/\.mdx$/, ".md");

export const packDocs: PackDocsFunction = async ({ source, target, version, site }) => {
  const files = (await walk(source)).filter((path) => !isFrontPage(path));
  const unknown = files.filter(
    (path) =>
      !/\.mdx?$/.test(path) || !GROUPS.some(({ directory }) => path.startsWith(`${directory}/`)),
  );
  if (unknown.length > 0) {
    throw new Error(`docs outside a known group or not Markdown: ${unknown.join(", ")}`);
  }
  const pages = await Promise.all(
    files.map(async (path) => {
      const page = parsePage({
        path: outputOf(path),
        source: await readFile(join(source, path), "utf8"),
      });
      return path.endsWith(".mdx")
        ? { ...page, body: renderComponents({ path, body: page.body }) }
        : page;
    }),
  );
  const paths = new Set(pages.map((page) => page.path));
  await rm(target, { recursive: true, force: true });
  const outputs = [
    ...pages.map((page) => ({ path: page.path, text: renderPage({ page, pages: paths, site }) })),
    { path: INDEX, text: renderIndex({ pages, version, site }) },
  ];
  await Promise.all(
    outputs.map(async ({ path, text }) => {
      const file = join(target, ...path.split(posix.sep));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
    }),
  );
  return outputs.map(({ path }) => path).toSorted();
};
