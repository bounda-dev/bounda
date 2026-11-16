import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fromWorkspaceCatalog } from "../versions.ts";
import { type Drift, driftBetween, readTree } from "./drift.ts";
import { appendLines, type JsonObject, mergeManifest, resolveCatalog } from "./transform.ts";

const run = promisify(execFile);

const packageRoot = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(packageRoot, "../..");
const distributionRoot = join(packageRoot, "distribution");

/**
 * The copy of the Cloudflare template kept outside this repository: `bounda-dev/bounda-cloudflare-template`,
 * with the Deploy to Cloudflare button.
 */
const COPY = "bounda-cloudflare-template";

/**
 * What the copy adds to the scaffolder's output, from `distribution/<copy>/layer.json`.
 */
export interface Layer {
  readonly name: string;
  readonly license: boolean;
  readonly gitignore: readonly string[];
  readonly package: JsonObject;
}

/**
 * Where the scaffolder comes from: the version published on npm, which is what a copy must match
 * because it installs Bounda from the registry, or this workspace's build, to try a change before
 * it is released.
 */
export type Scaffolder = "published" | "workspace";

const REGENERATED = ["package-lock.json", "worker-configuration.d.ts"];
const SKIP = [".git", "node_modules", ".wrangler", ".bounda", "+types"];
const REGISTRY = "https://registry.npmjs.org";
const BOUNDA_PACKAGES = [
  "create-bounda",
  "@bounda-dev/core",
  "@bounda-dev/cli",
  "@bounda-dev/cloudflare",
];

const readJson = async (path: string): Promise<JsonObject> =>
  JSON.parse(await readFile(path, "utf8")) as JsonObject;

const writeJson = (path: string, value: JsonObject): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

export interface LoadLayerFunction {
  (): Promise<Layer>;
}

export const loadLayer: LoadLayerFunction = async () =>
  (await readJson(join(distributionRoot, COPY, "layer.json"))) as unknown as Layer;

const settle = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const published = async (name: string): Promise<JsonObject> => {
  const response = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}`, {
    headers: { "cache-control": "no-cache" },
  });
  if (!response.ok) throw new Error(`${name}: the registry answered ${response.status}`);
  return (await response.json()) as JsonObject;
};

interface PublishedVersionFunction {
  (options?: { readonly timeoutMs?: number }): Promise<string>;
}

/**
 * The version `create-bounda` publishes under `latest`, once every Bounda package the copy
 * installs is served at that version: right after a release the registry can take minutes.
 */
const publishedVersion: PublishedVersionFunction = async ({ timeoutMs = 600_000 } = {}) => {
  const latest = (await published("create-bounda"))["dist-tags"] as JsonObject;
  const version = String(latest.latest);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const served = await Promise.all(
      BOUNDA_PACKAGES.map(async (name) => {
        const versions = (await published(name)).versions as JsonObject | undefined;
        return versions !== undefined && version in versions;
      }),
    );
    if (served.every(Boolean)) return version;
    if (Date.now() > deadline) throw new Error(`the registry does not serve ${version} yet`);
    await settle(15_000);
  }
};

interface ScaffoldArgs {
  readonly scaffolder: Scaffolder;
  readonly name: string;
  readonly cwd: string;
}

const scaffold = async ({ scaffolder, name, cwd }: ScaffoldArgs): Promise<void> => {
  const flags = [name, "--runtime", "cloudflare", "--pm", "npm", "--no-install", "--no-git"];
  if (scaffolder === "workspace") {
    await run(process.execPath, [join(packageRoot, "dist/cli.js"), ...flags, "--yes"], { cwd });
    return;
  }
  const version = await publishedVersion();
  await run(
    "npm",
    ["exec", "--yes", "--prefer-online", "--", `create-bounda@${version}`, ...flags, "--yes"],
    { cwd },
  );
};

export interface GenerateArgs {
  readonly scaffolder: Scaffolder;
  /**
   * Install the project to write `package-lock.json` and `worker-configuration.d.ts`. Off only
   * in tests.
   */
  readonly install?: boolean;
}

export interface GenerateResult {
  /**
   * A temporary directory to remove once done; the copy is `project`, laid out like its repository.
   */
  readonly root: string;
  readonly project: string;
  readonly layer: Layer;
}

export interface GenerateFunction {
  (args: GenerateArgs): Promise<GenerateResult>;
}

/**
 * The app's code always comes from the scaffolder; a copy only adds its layer over it.
 */
export const generate: GenerateFunction = async ({ scaffolder, install = true }) => {
  const layer = await loadLayer();
  const root = await mkdtemp(join(tmpdir(), `bounda-${COPY}-`));
  await scaffold({ scaffolder, name: layer.name, cwd: root });
  const project = await hoist(join(root, layer.name), root);
  // The master key the scaffolder generates is this machine's: whoever deploys the copy sets their
  // own, as `.dev.vars.example` asks.
  await rm(join(project, ".dev.vars"), { force: true });

  const extras = resolveCatalog(layer.package, fromWorkspaceCatalog);
  await writeJson(
    join(project, "package.json"),
    mergeManifest(await readJson(join(project, "package.json")), extras),
  );

  const gitignore = join(project, ".gitignore");
  await writeFile(gitignore, appendLines(await readFile(gitignore, "utf8"), layer.gitignore));
  await cp(join(distributionRoot, COPY, "files"), project, { recursive: true });
  if (layer.license) await cp(join(repoRoot, "LICENSE"), join(project, "LICENSE"));

  if (install) {
    await run("npm", ["install", "--no-audit", "--progress=false", "--prefer-online"], {
      cwd: project,
    });
    await run("npx", ["wrangler", "types"], { cwd: project });
    for (const directory of ["node_modules", ".wrangler"]) {
      await rm(join(project, directory), { recursive: true, force: true });
    }
  }
  return { root, project, layer };
};

const hoist = async (generated: string, root: string): Promise<string> => {
  const project = join(root, "copy");
  await cp(generated, project, { recursive: true });
  await rm(generated, { recursive: true, force: true });
  return project;
};

export interface SyncArgs {
  readonly scaffolder: Scaffolder;
  /**
   * A clone of the copy's repository. It is rewritten in place and left for a pull request.
   */
  readonly into: string;
}

export interface SyncFunction {
  (args: SyncArgs): Promise<void>;
}

const replaceTree = async (from: string, to: string, keep: readonly string[]): Promise<void> => {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(to)) {
    if (!keep.includes(entry)) await rm(join(to, entry), { recursive: true, force: true });
  }
  await cp(from, to, { recursive: true });
};

/**
 * Writes a freshly generated copy into a clone of its repository.
 */
export const sync: SyncFunction = async ({ scaffolder, into }) => {
  const { root, project } = await generate({ scaffolder });
  try {
    await replaceTree(project, into, [".git"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

export interface CheckArgs {
  readonly scaffolder: Scaffolder;
  /**
   * A clone of `bounda-cloudflare-template` to compare with. Cloned from GitHub when omitted.
   */
  readonly clone?: string;
}

export interface CheckFunction {
  (args: CheckArgs): Promise<readonly Drift[]>;
}

/**
 * Only the files the `bounda-cloudflare-template` repository tracks are compared.
 */
export const check: CheckFunction = async ({ scaffolder, clone }) => {
  const { root, project } = await generate({ scaffolder });
  const workspace = clone ?? (await mkdtemp(join(tmpdir(), "bounda-cloudflare-template-clone-")));
  try {
    if (clone === undefined) {
      await run("git", [
        "clone",
        "--depth",
        "1",
        "https://github.com/bounda-dev/bounda-cloudflare-template.git",
        workspace,
      ]);
    }
    const { stdout } = await run("git", ["ls-files", "-z"], { cwd: workspace });
    const tracked = new Set(stdout.split("\0").filter(Boolean));
    const files = await readTree(workspace, SKIP);
    return driftBetween({
      expected: await readTree(project, SKIP),
      actual: new Map([...files].filter(([path]) => tracked.has(path))),
      regenerated: REGENERATED,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    if (clone === undefined) await rm(workspace, { recursive: true, force: true });
  }
};
