import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { StateTypeSource } from "./emit/types.ts";
import type { AggregateModel, ProjectModel } from "./model.ts";
import { compareNames } from "./naming.ts";
import { isInGenerated } from "./write.ts";

export interface StateSource {
  // Relative to the project root, with forward slashes.
  readonly relativePath: string;
  readonly text: string;
}

/**
 * By aggregate name: the modules that shape its state, by path.
 */
export type StateSources = Readonly<Record<string, readonly StateSource[]>>;

const COMMENTS = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm;
// Static imports and re-exports with a specifier, `import type` left out, and dynamic imports.
const STATIC_IMPORT = /^\s*import\s+(?!type\s)(?:[^"'`;]*?\sfrom\s*)?["']([^"'\n]+)["']/gm;
const EXPORT_FROM = /^\s*export\s+(?!type\s)[^"'`;]*?\sfrom\s*["']([^"'\n]+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g;

const specifiersOf = (text: string): readonly string[] => {
  const stripped = text.replace(COMMENTS, "");
  return [STATIC_IMPORT, EXPORT_FROM, DYNAMIC_IMPORT].flatMap((pattern) =>
    [...stripped.matchAll(pattern)].map((match) => match[1] ?? ""),
  );
};

const isFile = async (path: string): Promise<boolean> =>
  stat(path).then(
    (found) => found.isFile(),
    () => false,
  );

/**
 * As TypeScript resolves a relative specifier to a source file: as written, `.js` for `.ts`,
 * without an extension, or a folder's `index.ts`. `null` for one no file answers to.
 */
const resolveRelative = async (from: string, specifier: string): Promise<string | null> => {
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    base.replace(/\.(js|jsx|mjs)$/, (_match, extension: string) =>
      extension === "jsx" ? ".tsx" : extension === "mjs" ? ".mts" : ".ts",
    ),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
  ].filter((candidate) => /\.(ts|tsx|mts)$/.test(candidate));
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
};

const rootsOf = (aggregate: AggregateModel): readonly string[] => [
  ...(aggregate.state === null ? [] : [aggregate.state.path]),
  ...aggregate.events.flatMap((event) => [
    event.path,
    ...(event.upcasts === null ? [] : [event.upcasts.path]),
  ]),
];

/**
 * Every module reached from `roots` through relative imports, the generated files left out,
 * since they are made from these same modules and what they import is types alone. A
 * specifier that is not relative, a package or a path alias, is not followed.
 */
const walk = async (root: string, roots: readonly string[]): Promise<readonly StateSource[]> => {
  const texts = new Map<string, string>();
  const pending = [...roots];
  for (let path = pending.shift(); path !== undefined; path = pending.shift()) {
    if (texts.has(path)) continue;
    const text = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
    texts.set(path, text);
    for (const specifier of specifiersOf(text)) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      const resolved = await resolveRelative(path, specifier);
      if (resolved === null || isInGenerated(resolved) || resolved.includes("node_modules")) {
        continue;
      }
      pending.push(resolved);
    }
  }
  return [...texts]
    .map(([path, text]) => ({
      relativePath: relative(root, path).split("\\").join("/"),
      text,
    }))
    .sort((left, right) => compareNames(left.relativePath, right.relativePath));
};

export interface ReadStateSourcesFunction {
  (model: ProjectModel): Promise<StateSources>;
}

/**
 * Reads, for every aggregate, the modules that shape its state: `state.ts`, its events with
 * their upcasts, and whatever those import through relative paths, transitively.
 */
export const readStateSources: ReadStateSourcesFunction = async (model) =>
  Object.fromEntries(
    await Promise.all(
      model.aggregates.map(
        async (aggregate) => [aggregate.name, await walk(model.root, rootsOf(aggregate))] as const,
      ),
    ),
  );

export interface FingerprintStatesArgs {
  readonly sources: StateSources;
  /**
   * By aggregate name; the type the generator inferred, when it did, is part of the fingerprint.
   */
  readonly inferredStates?: Readonly<Record<string, StateTypeSource>>;
}

export interface FingerprintStatesFunction {
  (args: FingerprintStatesArgs): Readonly<Record<string, string>>;
}

/**
 * Sixteen hex digits per aggregate over the text of its state's modules, by path, and the state
 * type inferred for it: the same on every machine for the same sources, and different as soon as
 * any of them changes, formatting and comments included.
 */
export const fingerprintStates: FingerprintStatesFunction = ({ sources, inferredStates = {} }) =>
  Object.fromEntries(
    Object.entries(sources).map(([aggregate, modules]) => {
      const hash = createHash("sha256");
      for (const { relativePath, text } of modules) hash.update(`${relativePath}\n${text}\0`);
      hash.update(inferredStates[aggregate]?.inferred ?? "");
      return [aggregate, hash.digest("hex").slice(0, 16)];
    }),
  );
