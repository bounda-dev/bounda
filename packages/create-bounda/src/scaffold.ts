import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { CreateOptions } from "./options.ts";
import { runCommand } from "./steps.ts";
import type { Versions } from "./versions.ts";

export interface ScaffoldProjectArgs {
  readonly templateRoot: string;
  readonly options: CreateOptions;
  readonly versions: Versions;
}

export interface ScaffoldReport {
  // Relative to the project directory, with `/` on every platform, sorted.
  readonly files: readonly string[];
}

export interface ScaffoldProjectFunction {
  (args: ScaffoldProjectArgs): Promise<ScaffoldReport>;
}

const ADAPTER_PACKAGES = {
  sqlite: "@bounda-dev/sqlite",
  postgresql: "@bounda-dev/postgresql",
  "durable-object": "@bounda-dev/cloudflare",
} as const;

// Each becomes `{{<script>Command}}`, spelled for the package manager, so a README never tells bun
// users to run `bun test`, which is bun's own test runner.
const SCRIPTS = ["install", "test", "start", "dev", "build", "deploy", "generate"] as const;

const TEMPLATE_SUFFIX = ".tpl";
/**
 * Files that cannot travel under their real name: npm drops `.gitignore` from packages and the
 * repository ignores `.env.*`.
 */
const RENAMES: Readonly<Record<string, string>> = {
  _gitignore: ".gitignore",
  "_env.example": ".env.example",
};

// Paths inside the template are built with `/` and handled with `posix`, never with the platform's
// separator, so they come out the same on Windows; `join` only meets them at the file system.
const listFiles = async (root: string, prefix = ""): Promise<readonly string[]> => {
  const found: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listFiles(root, path)));
    else found.push(path);
  }
  return found;
};

const targetNameOf = (source: string): string => {
  const base = posix.basename(source);
  const withoutSuffix = base.endsWith(TEMPLATE_SUFFIX)
    ? base.slice(0, -TEMPLATE_SUFFIX.length)
    : base;
  return posix.join(posix.dirname(source), RENAMES[withoutSuffix] ?? withoutSuffix);
};

export interface RenderTemplateArgs {
  readonly content: string;
  readonly values: Readonly<Record<string, string>>;
}

export interface RenderTemplateFunction {
  (args: RenderTemplateArgs): string;
}

// An unknown key is an error, so a template typo cannot ship.
export const renderTemplate: RenderTemplateFunction = ({ content, values }) =>
  content.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`template refers to an unknown value "${key}"`);
    return value;
  });

const isEmptyDirectory = async (directory: string): Promise<boolean> => {
  try {
    return (await readdir(directory)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
};

export const scaffoldProject: ScaffoldProjectFunction = async ({
  templateRoot,
  options,
  versions,
}) => {
  if (!(await isEmptyDirectory(options.directory))) {
    throw new Error(`${options.directory} exists and is not empty`);
  }
  const values: Readonly<Record<string, string>> = {
    name: options.name,
    adapterPackage: ADAPTER_PACKAGES[options.database],
    boundaVersion: versions.bounda,
    typescriptVersion: versions.typescript,
    vitestVersion: versions.vitest,
    typesNodeVersion: versions.typesNode,
    reactVersion: versions.react,
    reactRouterVersion: versions.reactRouter,
    viteVersion: versions.vite,
    isbotVersion: versions.isbot,
    typesReactVersion: versions.typesReact,
    wranglerVersion: versions.wrangler,
    cloudflareVitestPluginVersion: versions.cloudflareVitestPlugin,
    cloudflareVitePluginVersion: versions.cloudflareVitePlugin,
    ...Object.fromEntries(
      SCRIPTS.map((script) => [`${script}Command`, runCommand(options.packageManager, script)]),
    ),
  };
  // Later layers win. A framework's files are the same on every runtime, except those that tie it
  // to one, which live in `<runtime>-<framework>`.
  const layers = [
    "base",
    options.database,
    ...(options.framework === "none"
      ? [options.runtime]
      : [options.framework, `${options.runtime}-${options.framework}`]),
  ].map((layer) => join(templateRoot, layer));
  const sources = new Map<string, string>();
  for (const layer of layers) {
    for (const file of await listFiles(layer)) sources.set(targetNameOf(file), join(layer, file));
  }
  const written: string[] = [];
  for (const [target, source] of sources) {
    const raw = await readFile(source, "utf8");
    const content = source.endsWith(TEMPLATE_SUFFIX)
      ? renderTemplate({ content: raw, values })
      : raw;
    const path = join(options.directory, target);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    written.push(target);
  }
  return { files: written.sort() };
};
