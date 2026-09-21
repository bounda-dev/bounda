import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { CreateOptions } from "./options.ts";
import type { Versions } from "./versions.ts";

export interface ScaffoldProjectArgs {
  /**
   * The `template/` directory shipped with the package: `base/` plus one overlay per database.
   */
  readonly templateRoot: string;
  readonly options: CreateOptions;
  readonly versions: Versions;
}

export interface ScaffoldReport {
  /**
   * Files written, relative to the project directory, sorted.
   */
  readonly files: readonly string[];
}

export interface ScaffoldProjectFunction {
  (args: ScaffoldProjectArgs): Promise<ScaffoldReport>;
}

const ADAPTER_PACKAGES = {
  sqlite: "@bounda-dev/adapter-sqlite",
  postgresql: "@bounda-dev/adapter-postgresql",
} as const;

const TEMPLATE_SUFFIX = ".tpl";
const RENAMES: Readonly<Record<string, string>> = { _gitignore: ".gitignore" };

const listFiles = async (root: string): Promise<readonly string[]> => {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path));
    }
  };
  await walk(root);
  return found;
};

const targetNameOf = (source: string): string => {
  const base = source.split("/").pop() ?? source;
  const renamed = RENAMES[base] ?? base;
  const withoutSuffix = renamed.endsWith(TEMPLATE_SUFFIX)
    ? renamed.slice(0, -TEMPLATE_SUFFIX.length)
    : renamed;
  return join(dirname(source), withoutSuffix);
};

export interface RenderTemplateArgs {
  readonly content: string;
  readonly values: Readonly<Record<string, string>>;
}

export interface RenderTemplateFunction {
  (args: RenderTemplateArgs): string;
}

/**
 * Replaces every `{{key}}`; an unknown key is an error, so a template typo cannot ship.
 */
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

/**
 * Copies `base/` and the database overlay into the project directory, rendering `*.tpl` files
 * and renaming `_gitignore`. The directory must not exist or be empty.
 */
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
    pm: options.packageManager,
    adapterPackage: ADAPTER_PACKAGES[options.database],
    boundaVersion: versions.bounda,
    typescriptVersion: versions.typescript,
    vitestVersion: versions.vitest,
    typesNodeVersion: versions.typesNode,
  };
  const layers = [join(templateRoot, "base"), join(templateRoot, options.database)];
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
