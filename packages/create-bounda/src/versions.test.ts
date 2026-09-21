import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { currentVersions, fromWorkspaceCatalog, type Manifest, versionsFrom } from "./versions.ts";

const workspace = (): Promise<string> =>
  readFile(resolve(import.meta.dirname, "../../../pnpm-workspace.yaml"), "utf8");

const catalogVersion = async (name: string): Promise<string> => {
  const entry = new RegExp(`^\\s*"?${name.replace("/", "\\/")}"?:\\s*(\\S+)$`, "m");
  const match = entry.exec(await workspace());
  if (match?.[1] === undefined) throw new Error(`${name} is not in the catalog`);
  return match[1];
};

const TOOLS = [
  "typescript",
  "vitest",
  "@types/node",
  "react",
  "react-router",
  "vite",
  "isbot",
  "@types/react",
];

const manifestOf = (
  specifier: string,
  overrides: Readonly<Record<string, string>> = {},
): Manifest => ({
  version: "1.2.3",
  devDependencies: {
    ...Object.fromEntries(TOOLS.map((name) => [name, specifier])),
    ...overrides,
  },
});

describe("versions", () => {
  it("reads a resolved manifest without touching the catalog", () => {
    const versions = versionsFrom({
      manifest: manifestOf("9.9.9", { typescript: "7.0.2", react: "^19.3.0" }),
      catalog: (name) => {
        throw new Error(`the catalog was read for ${name}`);
      },
    });
    expect(versions.typescript).toBe("^7.0.2");
    expect(versions.react).toBe("^19.3.0");
    expect(versions.bounda).toBe("^1.2.3");
  });

  it("resolves a catalog specifier through the catalog", () => {
    const versions = versionsFrom({
      manifest: manifestOf("catalog:"),
      catalog: (name) => (name === "vite" ? "8.3.0" : "0.0.0"),
    });
    expect(versions.vite).toBe("^8.3.0");
    expect(versions.isbot).toBe("^0.0.0");
  });

  it("refuses a tool that is not a dev dependency", () => {
    const { typescript: _, ...withoutTypescript } = manifestOf("catalog:").devDependencies;
    expect(() =>
      versionsFrom({
        manifest: { version: "1.2.3", devDependencies: withoutTypescript },
        catalog: () => "1.0.0",
      }),
    ).toThrow("typescript is not a dev dependency");
  });

  it("reads a scoped name out of the catalog", async () => {
    expect(fromWorkspaceCatalog("@types/node")).toBe(await catalogVersion("@types/node"));
    expect(fromWorkspaceCatalog("vite")).toBe(await catalogVersion("vite"));
  });

  it("refuses a name the catalog does not carry", () => {
    expect(() => fromWorkspaceCatalog("not-a-package")).toThrow(
      "not-a-package is not in the workspace catalog",
    );
  });

  it("pins the tools to the workspace catalog", async () => {
    const versions = currentVersions();
    expect(versions.typescript).toBe(`^${await catalogVersion("typescript")}`);
    expect(versions.vitest).toBe(`^${await catalogVersion("vitest")}`);
    expect(versions.typesNode).toBe(`^${await catalogVersion("@types/node")}`);
    expect(versions.react).toBe(`^${await catalogVersion("react")}`);
    expect(versions.reactRouter).toBe(`^${await catalogVersion("react-router")}`);
    expect(versions.vite).toBe(`^${await catalogVersion("vite")}`);
    expect(versions.isbot).toBe(`^${await catalogVersion("isbot")}`);
    expect(versions.typesReact).toBe(`^${await catalogVersion("@types/react")}`);
  });

  it("keeps the catalog entries a single template version covers in step", async () => {
    expect(await catalogVersion("react-dom")).toBe(await catalogVersion("react"));
    expect(await catalogVersion("@types/react-dom")).toBe(await catalogVersion("@types/react"));
    for (const name of ["@react-router/dev", "@react-router/node", "@react-router/serve"]) {
      expect(await catalogVersion(name)).toBe(await catalogVersion("react-router"));
    }
  });

  it("uses its own version for the Bounda packages", async () => {
    const own = JSON.parse(
      await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { version: string };
    expect(currentVersions().bounda).toBe(`^${own.version}`);
  });
});
