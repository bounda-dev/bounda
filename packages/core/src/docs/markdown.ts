import { posix } from "node:path";

export interface Page {
  // Path under the docs root, such as `guides/testing.md`.
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly order: number;
  readonly body: string;
}

export interface ParsePageArgs {
  readonly path: string;
  readonly source: string;
}

export interface ParsePageFunction {
  (args: ParsePageArgs): Page;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

// The frontmatter of a docs page is flat `key: value` lines plus `sidebar:` with an indented
// `order:`; a YAML parser would be a dependency for three fields.
const field = (frontmatter: string, key: string): string | undefined => {
  const value = new RegExp(`^${key}: (.+)$`, "m").exec(frontmatter)?.[1]?.trim();
  if (value !== undefined && /^[>|][-+]?$/.test(value)) {
    throw new Error(`${key} is a multi-line value; write it on one line`);
  }
  if (value?.startsWith('"') && value.endsWith('"')) return JSON.parse(value) as string;
  if (value?.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replaceAll("''", "'");
  return value;
};

export const parsePage: ParsePageFunction = ({ path, source }) => {
  const match = FRONTMATTER.exec(source);
  if (match === null) throw new Error(`${path}: no frontmatter`);
  const [, frontmatter = ""] = match;
  const read = (key: string): string | undefined => {
    try {
      return field(frontmatter, key);
    } catch (error) {
      throw new Error(`${path}: ${(error as Error).message}`);
    }
  };
  const title = read("title");
  const description = read("description");
  if (title === undefined || description === undefined) {
    throw new Error(`${path}: the frontmatter needs a title and a description`);
  }
  const order = /^ {2}order: (\d+)$/m.exec(frontmatter)?.[1];
  return {
    path,
    title,
    description,
    order: order === undefined ? Number.POSITIVE_INFINITY : Number(order),
    body: source.slice(match[0].length),
  };
};

export interface PagePathOfArgs {
  // A site path such as `/guides/testing/`.
  readonly url: string;
  readonly pages: ReadonlySet<string>;
}

export interface PagePathOfFunction {
  (args: PagePathOfArgs): string | undefined;
}

// The site's front page has no Markdown of its own; the index the pack writes takes its place.
export const INDEX = "README.md";

export const pagePathOf: PagePathOfFunction = ({ url, pages }) => {
  const slug = url.replace(/^\/|\/$/g, "");
  if (slug === "") return INDEX;
  return [`${slug}.md`, `${slug}/index.md`].find((candidate) => pages.has(candidate));
};

export interface RewriteLinksArgs {
  readonly page: Page;
  readonly pages: ReadonlySet<string>;
  // The docs site, such as `https://docs.bounda.dev`, for links to its static files.
  readonly site: string;
}

export interface RewriteLinksFunction {
  (args: RewriteLinksArgs): string;
}

const FENCE = /^ *(`{3,}|~{3,})/;

const closes = (fence: string, marker: string | undefined): boolean =>
  marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length;

// Code samples are left as written: `href="/orders"` in a snippet is the app's route, not a page.
const outsideCode = (body: string, transform: (text: string) => string): string => {
  const parts: string[] = [];
  let text: string[] = [];
  let fence: string | undefined;
  for (const line of body.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence === undefined && marker !== undefined) {
      if (text.length > 0) parts.push(transform(text.join("\n")));
      text = [];
      fence = marker;
      parts.push(line);
    } else if (fence !== undefined) {
      parts.push(line);
      if (closes(fence, marker)) fence = undefined;
    } else {
      text.push(line);
    }
  }
  if (text.length > 0) parts.push(transform(text.join("\n")));
  return parts.join("\n");
};

const LINK = /\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g;
const SOURCE = /\b(src|href)="(\/[^"]*)"/g;

// Links between pages become relative file links, so they work from `node_modules`. One to a page
// that does not exist throws: a broken link fails the build instead of shipping.
export const rewriteLinks: RewriteLinksFunction = ({ page, pages, site }) => {
  const from = posix.dirname(page.path);
  const toFile = (url: string): string => {
    if (/\.[a-z0-9]+$/i.test(url)) return `${site}${url}`;
    const target = pagePathOf({ url, pages });
    if (target === undefined) throw new Error(`${page.path}: no page for the link ${url}`);
    const relative = posix.relative(from, target);
    return relative.startsWith(".") ? relative : `./${relative}`;
  };
  return outsideCode(page.body, (text) =>
    text
      .replace(LINK, (_, url: string, anchor = "") => `](${toFile(url)}${anchor})`)
      .replace(SOURCE, (_, attribute: string, url: string) => `${attribute}="${toFile(url)}"`),
  );
};

export interface RenderAsidesFunction {
  (body: string): string;
}

const ASIDE_OPEN = /^:::(note|tip|caution|danger)(?:\[(.+)\])?$/;

// Starlight's `:::note` blocks become blockquotes, which any Markdown reader shows; code inside
// one stays in the quote, and `:::` inside a code block is code.
export const renderAsides: RenderAsidesFunction = (body) => {
  const lines: string[] = [];
  let fence: string | undefined;
  let inAside = false;
  for (const line of body.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    const inCode = fence !== undefined;
    if (fence !== undefined) {
      if (closes(fence, marker)) fence = undefined;
    } else if (marker !== undefined) {
      fence = marker;
    }
    const open = inCode || marker !== undefined ? null : ASIDE_OPEN.exec(line);
    if (!inAside && open !== null) {
      const [, kind = "", title] = open;
      const label = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
      lines.push(`> **${title === undefined ? label : `${label}: ${title}`}**`, ">");
      inAside = true;
    } else if (inAside && !inCode && line === ":::") {
      inAside = false;
    } else if (inAside) {
      lines.push(line === "" ? ">" : `> ${line}`);
    } else {
      lines.push(line);
    }
  }
  return lines.join("\n");
};

export interface RenderComponentsArgs {
  readonly path: string;
  readonly body: string;
}

export interface RenderComponentsFunction {
  (args: RenderComponentsArgs): string;
}

const STARLIGHT_IMPORT = /^import \{[^}]*\} from "@astrojs\/starlight\/components";$/;
const COMPONENT = /^<(\/?)([A-Z]\w*)([^>]*?)\/?>$/;
const LABEL = /\blabel="([^"]*)"/;
// Components with a plain Markdown form: their tags go, and what they wrap stays. A tab becomes its
// label in bold over its content.
const UNWRAPPED: ReadonlySet<string> = new Set(["Tabs", "Steps", "FileTree"]);

// Pages are MDX only for Starlight's layout components; any other component has no Markdown form
// and throws, so a page that needs one is a decision, not a silent loss.
export const renderComponents: RenderComponentsFunction = ({ path, body }) => {
  const lines: string[] = [];
  let fence: string | undefined;
  let indent: number | undefined;
  let inTab = false;
  for (const raw of body.split("\n")) {
    const blank = raw.trim() === "";
    const depth = raw.length - raw.trimStart().length;
    if (inTab && indent === undefined && !blank) indent = depth;
    const line = !inTab ? raw : blank ? "" : raw.slice(Math.min(indent ?? 0, depth));
    const marker = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (closes(fence, marker)) fence = undefined;
      lines.push(line);
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      lines.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("import ")) {
      if (!STARLIGHT_IMPORT.test(trimmed))
        throw new Error(`${path}: cannot pack the import ${trimmed}`);
      continue;
    }
    const tag = COMPONENT.exec(trimmed);
    if (tag === null) {
      lines.push(line);
      continue;
    }
    const [, closing = "", name = "", attributes = ""] = tag;
    if (UNWRAPPED.has(name)) continue;
    if (name !== "TabItem") {
      throw new Error(`${path}: <${name}> has no Markdown form; use Tabs, Steps or FileTree`);
    }
    if (closing === "/") {
      inTab = false;
      indent = undefined;
      lines.push("");
    } else {
      const label = LABEL.exec(attributes)?.[1];
      if (label === undefined) throw new Error(`${path}: a <TabItem> needs a label`);
      inTab = true;
      lines.push(`**${label}**`, "");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
};

export interface RenderPageArgs extends RewriteLinksArgs {}

export interface RenderPageFunction {
  (args: RenderPageArgs): string;
}

export const renderPage: RenderPageFunction = (args) =>
  `# ${args.page.title}\n\n${args.page.description}\n\n${renderAsides(rewriteLinks(args)).trimStart()}`;
