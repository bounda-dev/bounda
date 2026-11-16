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

interface MapDependenciesFunction {
  (manifest: JsonObject, map: (name: string, specifier: string) => string): JsonObject;
}

const mapDependencies: MapDependenciesFunction = (manifest, map) => {
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

export interface AppendLinesFunction {
  (content: string, lines: readonly string[]): string;
}

export const appendLines: AppendLinesFunction = (content, lines) => {
  const present = new Set(content.split("\n"));
  const missing = lines.filter((line) => !present.has(line));
  if (missing.length === 0) return content;
  return `${content.replace(/\n*$/, "\n")}${missing.join("\n")}\n`;
};
