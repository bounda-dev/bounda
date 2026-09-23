import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fromWorkspaceCatalog } from "../versions.ts";
import { type Drift, driftBetween, readTree } from "./drift.ts";
import {
  alignVersions,
  appendLines,
  type JsonObject,
  mergeManifest,
  pinExact,
  resolveCatalog,
  setCompatibilityDate,
  syncpackPins,
  targetCompatibilityDate,
} from "./transform.ts";

const run = promisify(execFile);

const packageRoot = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(packageRoot, "../..");
const distributionRoot = join(packageRoot, "distribution");

/**
 * The copies of the Cloudflare template kept outside this repository: its own repository, with
 * the Deploy to Cloudflare button, and its directory in `cloudflare/templates`.
 */
export type Target = "bounda-cloudflare-template" | "cloudflare-templates";

export const TARGETS: readonly Target[] = ["bounda-cloudflare-template", "cloudflare-templates"];

/**
 * What a copy adds to the scaffolder's output, from `distribution/<target>/layer.json`.
 */
export interface Layer {
  readonly name: string;
  /**
   * `project`: the copy is the project, at the root of its repository. `monorepo`: the project is
   * the `<name>` directory of a repository of templates, with files of its own next to it.
   */
  readonly layout: "project" | "monorepo";
  /**
   * `range`: the scaffolder's caret ranges. `aligned`: exact versions, the ones the rest of the
   * repository uses.
   */
  readonly pin: "range" | "aligned";
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
  "@bounda-dev/adapter-cloudflare",
];

const readJson = async (path: string): Promise<JsonObject> =>
  JSON.parse(await readFile(path, "utf8")) as JsonObject;

const writeJson = (path: string, value: JsonObject): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

export interface LoadLayerFunction {
  (target: Target): Promise<Layer>;
}

export const loadLayer: LoadLayerFunction = async (target) =>
  (await readJson(join(distributionRoot, target, "layer.json"))) as unknown as Layer;

const settle = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const published = async (name: string): Promise<JsonObject> => {
  const response = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}`, {
    headers: { "cache-control": "no-cache" },
  });
  if (!response.ok) throw new Error(`${name}: the registry answered ${response.status}`);
  return (await response.json()) as JsonObject;
};

export interface PublishedVersionFunction {
  (options?: { readonly timeoutMs?: number }): Promise<string>;
}

/**
 * The version `create-bounda` publishes under `latest`, once every Bounda package the copy
 * installs is served at that version: right after a release the registry can take minutes.
 */
export const publishedVersion: PublishedVersionFunction = async ({ timeoutMs = 600_000 } = {}) => {
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
  const flags = [name, "--framework", "cloudflare", "--pm", "npm", "--no-install", "--no-git"];
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

const templateManifests = async (repository: string, except: string): Promise<JsonObject[]> => {
  const manifests: JsonObject[] = [];
  for (const entry of await readdir(repository, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith("-template") || entry.name === except)
      continue;
    manifests.push(await readJson(join(repository, entry.name, "package.json")));
  }
  return manifests;
};

export interface GenerateArgs {
  readonly target: Target;
  readonly scaffolder: Scaffolder;
  /**
   * For `cloudflare-templates`: a clone of it, to align versions and read the compatibility
   * date its linter requires.
   */
  readonly repository?: string;
  /**
   * Install the project to write `package-lock.json` and `worker-configuration.d.ts`. Off only
   * in tests.
   */
  readonly install?: boolean;
}

export interface GenerateResult {
  /**
   * A directory laid out like the copy's repository: the project at its root, or in `<name>/`
   * for `monorepo`.
   */
  readonly root: string;
  readonly project: string;
  readonly layer: Layer;
}

export interface GenerateFunction {
  (args: GenerateArgs): Promise<GenerateResult>;
}

/**
 * Builds a copy from the scaffolder's output: its `package.json` extras, its own files over the
 * generated ones, versions pinned as the copy needs, and, with `install`, the lockfile and the
 * binding types. The app's code always comes from the scaffolder.
 */
export const generate: GenerateFunction = async ({
  target,
  scaffolder,
  repository,
  install = true,
}) => {
  const layer = await loadLayer(target);
  if (layer.pin === "aligned" && repository === undefined) {
    throw new Error(`${target} needs a clone of its repository`);
  }
  const root = await mkdtemp(join(tmpdir(), `bounda-${target}-`));
  await scaffold({ scaffolder, name: layer.name, cwd: root });
  const generated = join(root, layer.name);
  const project = layer.layout === "project" ? await hoist(generated, root) : generated;

  const extras = resolveCatalog(layer.package, fromWorkspaceCatalog);
  let manifest = mergeManifest(await readJson(join(project, "package.json")), extras);
  if (layer.pin === "aligned" && repository !== undefined) {
    manifest = alignVersions({
      manifest: pinExact(manifest),
      neighbours: await templateManifests(repository, layer.name),
      pinned: syncpackPins({
        config: await readJson(join(repository, ".syncpackrc.json")),
        packageName: layer.name,
      }),
    });
    const wrangler = join(project, "wrangler.jsonc");
    const date = targetCompatibilityDate(
      await readFile(join(repository, "cli/src/lint.ts"), "utf8"),
    );
    await writeFile(wrangler, setCompatibilityDate(await readFile(wrangler, "utf8"), date));
  }
  await writeJson(join(project, "package.json"), manifest);

  const gitignore = join(project, ".gitignore");
  await writeFile(gitignore, appendLines(await readFile(gitignore, "utf8"), layer.gitignore));
  await cp(join(distributionRoot, target, "files"), project, { recursive: true });
  const rootFiles = join(distributionRoot, target, "root");
  if (layer.layout === "monorepo") await cp(rootFiles, root, { recursive: true }).catch(skipAbsent);
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

const skipAbsent = (error: NodeJS.ErrnoException): void => {
  if (error.code !== "ENOENT") throw error;
};

const hoist = async (generated: string, root: string): Promise<string> => {
  const project = join(root, "copy");
  await cp(generated, project, { recursive: true });
  await rm(generated, { recursive: true, force: true });
  return project;
};

export interface SyncArgs {
  readonly target: Target;
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

const sha1 = async (path: string): Promise<string> =>
  createHash("sha1")
    .update(await readFile(path))
    .digest("hex");

/**
 * Writes a freshly generated copy into a clone of its repository. For `cloudflare-templates` it
 * also formats the manifest with the repository's syncpack and every file with its Prettier, and
 * records the new `package.json` hash in `templates.json`, as its own `fix` scripts would.
 */
export const sync: SyncFunction = async ({ target, scaffolder, into }) => {
  const { root, project, layer } = await generate({ target, scaffolder, repository: into });
  try {
    if (layer.layout === "project") {
      await replaceTree(project, into, [".git"]);
      return;
    }
    await replaceTree(project, join(into, layer.name), []);
    const tree = await readTree(root, [layer.name]);
    for (const [path, content] of tree) {
      await mkdir(dirname(join(into, path)), { recursive: true });
      await writeFile(join(into, path), content);
    }
    const devDependencies = (await readJson(join(into, "package.json")))
      .devDependencies as JsonObject;
    await run(
      "npx",
      [
        "--yes",
        `syncpack@${String(devDependencies.syncpack)}`,
        "format",
        "--source",
        `${layer.name}/package.json`,
      ],
      { cwd: into },
    );
    await run(
      "npx",
      [
        "--yes",
        `prettier@${String(devDependencies.prettier)}`,
        "--write",
        layer.name,
        ...tree.keys(),
      ],
      { cwd: into },
    );
    const registry = join(into, "templates.json");
    const templates = await readJson(registry);
    const entries = templates.templates as JsonObject;
    await writeFile(
      registry,
      JSON.stringify(
        {
          ...templates,
          templates: {
            ...entries,
            [layer.name]: { package_json_hash: await sha1(join(into, layer.name, "package.json")) },
          },
        },
        null,
        2,
      ),
    );
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
 * Compares the files `bounda-cloudflare-template` tracks with what a sync would write. The
 * lockfile and the binding types are only required to exist: they change with every third-party
 * release.
 */
export const check: CheckFunction = async ({ scaffolder, clone }) => {
  const { root, project } = await generate({ target: "bounda-cloudflare-template", scaffolder });
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
