import { readFileSync } from "node:fs";

/**
 * Versions written into the generated `package.json`. The Bounda packages share the version of
 * `create-bounda` itself, since they are released together.
 */
export interface Versions {
  readonly bounda: string;
  readonly typescript: string;
  readonly vitest: string;
  readonly typesNode: string;
  readonly react: string;
  readonly reactRouter: string;
  readonly vite: string;
  readonly isbot: string;
  readonly typesReact: string;
}

export interface Manifest {
  readonly version: string;
  readonly devDependencies: Readonly<Record<string, string>>;
}

export interface CatalogFunction {
  (name: string): string;
}

export interface VersionsFromArgs {
  readonly manifest: Manifest;
  readonly catalog: CatalogFunction;
}

export interface VersionsFromFunction {
  (args: VersionsFromArgs): Versions;
}

const CATALOG = /^catalog:/;

/**
 * The tools a generated project gets are this package's own dev dependencies: the workspace
 * catalog is the only place a third-party version is written down, and `pnpm pack` resolves the
 * `catalog:` specifiers into the published manifest.
 */
export const versionsFrom: VersionsFromFunction = ({ manifest, catalog }) => {
  const versionOf = (name: string): string => {
    const specifier = manifest.devDependencies[name];
    if (specifier === undefined) throw new Error(`${name} is not a dev dependency`);
    const version = CATALOG.test(specifier) ? catalog(name) : specifier;
    return `^${version.replace(/^\^/, "")}`;
  };
  return {
    bounda: `^${manifest.version}`,
    typescript: versionOf("typescript"),
    vitest: versionOf("vitest"),
    typesNode: versionOf("@types/node"),
    react: versionOf("react"),
    reactRouter: versionOf("react-router"),
    vite: versionOf("vite"),
    isbot: versionOf("isbot"),
    typesReact: versionOf("@types/react"),
  };
};

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

/** Only used inside the workspace: a published install has its versions in the manifest. */
export const fromWorkspaceCatalog: CatalogFunction = (name) => {
  const workspace = read("../../../pnpm-workspace.yaml");
  const entry = new RegExp(`^\\s*"?${name.replaceAll(".", "\\.")}"?:\\s*(\\S+)$`, "m");
  const match = entry.exec(workspace);
  if (match?.[1] === undefined) throw new Error(`${name} is not in the workspace catalog`);
  return match[1];
};

export interface CurrentVersionsFunction {
  (): Versions;
}

/**
 * The versions for a project created by this build of `create-bounda`. Outside the workspace the
 * manifest already carries resolved versions, so the catalog is never read.
 */
export const currentVersions: CurrentVersionsFunction = () =>
  versionsFrom({
    manifest: JSON.parse(read("../package.json")) as Manifest,
    catalog: fromWorkspaceCatalog,
  });
