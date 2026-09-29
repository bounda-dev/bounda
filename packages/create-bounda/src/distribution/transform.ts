export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

export type JsonObject = { readonly [key: string]: Json };

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies"] as const;

export interface MergeManifestFunction {
  (base: JsonObject, patch: JsonObject): JsonObject;
}

/**
 * Dependency maps come out sorted by name, as npm writes them.
 */
export const mergeManifest: MergeManifestFunction = (base, patch) => {
  const merge = (left: JsonObject, right: JsonObject): JsonObject => {
    const merged: Record<string, Json> = { ...left };
    for (const [key, value] of Object.entries(right)) {
      const current = merged[key];
      merged[key] = isObject(current) && isObject(value) ? merge(current, value) : value;
    }
    return merged;
  };
  const merged = merge(base, patch);
  const ordered: Record<string, Json> = {};
  for (const key of ["name", "description"]) {
    const value = merged[key];
    if (value !== undefined) ordered[key] = value;
  }
  for (const [key, value] of Object.entries(merged)) {
    if (key in ordered) continue;
    ordered[key] =
      (DEPENDENCY_FIELDS as readonly string[]).includes(key) && isObject(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value;
  }
  return ordered;
};

export interface MapDependenciesFunction {
  (manifest: JsonObject, map: (name: string, specifier: string) => string): JsonObject;
}

export const mapDependencies: MapDependenciesFunction = (manifest, map) => {
  const mapped: Record<string, Json> = { ...manifest };
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (!isObject(dependencies)) continue;
    mapped[field] = Object.fromEntries(
      Object.entries(dependencies).map(([name, specifier]) => [name, map(name, String(specifier))]),
    );
  }
  return mapped;
};

const CATALOG = /^catalog:/;

export interface ResolveCatalogFunction {
  (manifest: JsonObject, catalog: (name: string) => string): JsonObject;
}

/**
 * A layer writes `catalog:` so that a copy's extra tools are pinned in the workspace catalog, like
 * the scaffolder's own.
 */
export const resolveCatalog: ResolveCatalogFunction = (manifest, catalog) =>
  mapDependencies(manifest, (name, specifier) =>
    CATALOG.test(specifier) ? `^${catalog(name)}` : specifier,
  );

export interface PinExactFunction {
  (manifest: JsonObject): JsonObject;
}

export const pinExact: PinExactFunction = (manifest) =>
  mapDependencies(manifest, (_name, specifier) => specifier.replace(/^[\^~]/, ""));

export interface AlignVersionsArgs {
  readonly manifest: JsonObject;
  /**
   * The manifests of the other packages in the repository the copy goes into.
   */
  readonly neighbours: readonly JsonObject[];
  /**
   * Versions the repository pins for this package on purpose.
   */
  readonly pinned: Readonly<Record<string, string>>;
}

export interface AlignVersionsFunction {
  (args: AlignVersionsArgs): JsonObject;
}

const versionsOf = (manifests: readonly JsonObject[], name: string): readonly string[] =>
  manifests.flatMap((manifest) =>
    DEPENDENCY_FIELDS.flatMap((field) => {
      const dependencies = manifest[field];
      const version = isObject(dependencies) ? dependencies[name] : undefined;
      return typeof version === "string" ? [version] : [];
    }),
  );

const mostCommon = (values: readonly string[]): string | undefined => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(([, a], [, b]) => b - a)[0]?.[0];
};

/**
 * For a repository that keeps one version per tool across its packages.
 */
export const alignVersions: AlignVersionsFunction = ({ manifest, neighbours, pinned }) =>
  mapDependencies(
    manifest,
    (name, specifier) => pinned[name] ?? mostCommon(versionsOf(neighbours, name)) ?? specifier,
  );

export interface SyncpackPinsArgs {
  readonly config: JsonObject;
  readonly packageName: string;
}

export interface SyncpackPinsFunction {
  (args: SyncpackPinsArgs): Readonly<Record<string, string>>;
}

export const syncpackPins: SyncpackPinsFunction = ({ config, packageName }) => {
  const groups = config.versionGroups;
  if (!Array.isArray(groups)) return {};
  const pins: Record<string, string> = {};
  for (const group of groups as readonly Json[]) {
    if (!isObject(group) || typeof group.pinVersion !== "string") continue;
    const packages = Array.isArray(group.packages) ? group.packages : [];
    const dependencies = Array.isArray(group.dependencies) ? group.dependencies : [];
    if (!packages.includes(packageName)) continue;
    for (const dependency of dependencies) {
      if (typeof dependency === "string" && !(dependency in pins))
        pins[dependency] = group.pinVersion;
    }
  }
  return pins;
};

const COMPATIBILITY_DATE = /("compatibility_date":\s*")(\d{4}-\d{2}-\d{2})(")/;

export interface SetCompatibilityDateFunction {
  (wrangler: string, date: string): string;
}

/**
 * Replaces the date in place rather than parsing the file, so its comments and layout survive.
 */
export const setCompatibilityDate: SetCompatibilityDateFunction = (wrangler, date) => {
  if (!COMPATIBILITY_DATE.test(wrangler))
    throw new Error("wrangler.jsonc has no compatibility_date");
  return wrangler.replace(COMPATIBILITY_DATE, `$1${date}$3`);
};

export interface TargetCompatibilityDateFunction {
  (lintSource: string): string;
}

/**
 * The compatibility date `cloudflare/templates` requires, read from the constant its template
 * linter checks against.
 */
export const targetCompatibilityDate: TargetCompatibilityDateFunction = (lintSource) => {
  const match = /TARGET_COMPATIBILITY_DATE\s*=\s*"(\d{4}-\d{2}-\d{2})"/.exec(lintSource);
  if (match?.[1] === undefined) throw new Error("TARGET_COMPATIBILITY_DATE not found");
  return match[1];
};

export interface AppendLinesFunction {
  (content: string, lines: readonly string[]): string;
}

export const appendLines: AppendLinesFunction = (content, lines) => {
  const present = new Set(content.split("\n"));
  const missing = lines.filter((line) => !present.has(line));
  if (missing.length === 0) return content;
  return `${content.replace(/\n*$/, "\n")}${missing.join("\n")}\n`;
};
