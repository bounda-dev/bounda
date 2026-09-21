import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { currentVersions, TOOL_VERSIONS } from "./versions.ts";

const catalogVersion = async (name: string): Promise<string> => {
  const workspace = await readFile(
    resolve(import.meta.dirname, "../../../pnpm-workspace.yaml"),
    "utf8",
  );
  const match = new RegExp(`^\\s*"?${name.replace("/", "\\/")}"?:\\s*(\\S+)$`, "m").exec(workspace);
  if (match?.[1] === undefined) throw new Error(`${name} is not in the catalog`);
  return match[1];
};

describe("versions", () => {
  it("pins the tools to the workspace catalog", async () => {
    expect(TOOL_VERSIONS.typescript).toBe(`^${await catalogVersion("typescript")}`);
    expect(TOOL_VERSIONS.vitest).toBe(`^${await catalogVersion("vitest")}`);
    expect(TOOL_VERSIONS.typesNode).toBe(`^${await catalogVersion("@types/node")}`);
  });

  it("uses its own version for the Bounda packages", async () => {
    const own = JSON.parse(
      await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { version: string };
    expect(currentVersions().bounda).toBe(`^${own.version}`);
  });
});
