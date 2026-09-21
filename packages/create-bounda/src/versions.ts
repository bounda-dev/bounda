import { readFileSync } from "node:fs";

/**
 * Versions written into the generated `package.json`. The Bounda packages share the version of
 * `create-bounda` itself (they are released together); the tools are pinned to what this
 * repository tests against, and a test keeps them equal to the workspace catalog.
 */
export interface Versions {
  readonly bounda: string;
  readonly typescript: string;
  readonly vitest: string;
  readonly typesNode: string;
}

export const TOOL_VERSIONS: Omit<Versions, "bounda"> = {
  typescript: "^7.0.2",
  vitest: "^5.0.1",
  typesNode: "^26.6.1",
};

export interface CurrentVersionsFunction {
  (): Versions;
}

/**
 * The versions for a project created by this build of `create-bounda`.
 */
export const currentVersions: CurrentVersionsFunction = () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { readonly version: string };
  return { bounda: `^${packageJson.version}`, ...TOOL_VERSIONS };
};
