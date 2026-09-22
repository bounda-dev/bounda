import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { runCreate } from "./run.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const templateRoot = resolve(import.meta.dirname, "../template");
const run = promisify(execFile);
const temporary: string[] = [];

const packs = new Map<string, Promise<string>>();
const packDirectory = mkdtemp(join(tmpdir(), "create-bounda-packs-")).then((directory) => {
  temporary.push(directory);
  return directory;
});

/** The tarball npm would publish, `files` and all. Packed once per package per run. */
const tarballOf = (name: string): Promise<string> => {
  const packed =
    packs.get(name) ??
    packDirectory.then(async (destination) => {
      const { stdout } = await run("pnpm", ["pack", "--pack-destination", destination], {
        cwd: join(repoRoot, "packages", name),
      });
      return stdout.trim().split("\n").at(-1) as string;
    });
  packs.set(name, packed);
  return packed;
};

const link = async (target: string, path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
};

const dependenciesOf = async (name: string): Promise<readonly string[]> => {
  const path = join(repoRoot, "packages", name, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  return Object.keys(manifest.dependencies ?? {});
};

/**
 * Installs the workspace packages the way `npm install` would: the published tarball extracted
 * into the project's own node_modules. Vite then resolves them inside node_modules and
 * externalises them for the server environment, exactly as in a project created from the
 * registry. A symlink resolves to a path outside node_modules and stays internal, which is how a
 * plugin that only worked for linked packages reached the first alpha.
 */
const install = async (project: string, names: readonly string[]): Promise<void> => {
  const modules = join(project, "node_modules");
  for (const name of names) {
    const destination = join(modules, "@bounda-dev", name);
    await mkdir(destination, { recursive: true });
    await run("tar", ["-xzf", await tarballOf(name), "-C", destination, "--strip-components=1"]);
    for (const dependency of await dependenciesOf(name)) {
      await link(
        join(repoRoot, "packages", name, "node_modules", dependency),
        join(modules, dependency),
      );
    }
  }
};

/**
 * The tools the template declares, taken from this package's own dev dependencies: the same
 * versions it writes into the generated manifest.
 */
type Framework = "node" | "react-router" | "cloudflare";

const linkTools = async (project: string, framework: Framework): Promise<void> => {
  const modules = join(project, "node_modules");
  const own = join(repoRoot, "packages/create-bounda/node_modules");
  for (const name of ["vitest", "typescript", "@types/node"]) {
    await link(join(own, name), join(modules, name));
  }
  if (framework === "cloudflare") {
    for (const name of ["wrangler", "@cloudflare/workers-types"]) {
      await link(join(own, name), join(modules, name));
    }
    return;
  }
  if (framework !== "react-router") return;
  for (const name of [
    "react",
    "react-dom",
    "react-router",
    "vite",
    "isbot",
    "@react-router/dev",
    "@react-router/node",
    "@react-router/serve",
    "@types/react",
    "@types/react-dom",
  ]) {
    await link(join(own, name), join(modules, name));
  }
};

const scaffold = async (argv: readonly string[], framework: Framework): Promise<string> => {
  const cwd = await mkdtemp(join(tmpdir(), "create-bounda-e2e-"));
  temporary.push(cwd);
  const code = await runCreate({
    argv: [...argv],
    cwd,
    stdout: { write: () => undefined },
    stderr: { write: (text: string) => process.stderr.write(text) },
    templateRoot,
    prompts: null,
  });
  expect(code).toBe(0);
  const project = join(cwd, argv[0] as string);
  await install(project, [
    "core",
    "cli",
    framework === "cloudflare" ? "adapter-cloudflare" : "adapter-sqlite",
    ...(framework === "react-router" ? ["react-router"] : []),
  ]);
  await linkTools(project, framework);
  return project;
};

const settle = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const until = async (
  condition: () => boolean | Promise<boolean>,
  describeFailure: () => string,
  timeoutMs = 30_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(describeFailure());
    await settle(50);
  }
};

/** The whole group: `react-router dev` relaunches itself, so the listener outlives the child. */
const stop = async (child: ChildProcess): Promise<void> => {
  const { pid } = child;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(-pid, name);
    } catch {
      child.kill(name);
    }
  };
  signal("SIGTERM");
  await Promise.race([exited, settle(3_000).then(() => signal("SIGKILL"))]);
};

interface DevServer {
  readonly url: string;
  readonly stop: () => Promise<void>;
}

/**
 * The bug that made this test install tarballs only showed up in dev: the production build
 * resolved the app module through the plugin and succeeded while every request 500ed.
 *
 * Readiness is a request that answers, not a line in the log: the banner's wording is Vite's to
 * change. Both addresses are tried because the dev server binds the `localhost` hostname, which
 * resolves to `::1` on some hosts and to `127.0.0.1` on others.
 */
const devServer = async (
  project: string,
  bin: string,
  extra: readonly string[] = [],
): Promise<DevServer> => {
  const port = await freePort();
  const child = spawn(process.execPath, [bin, "dev", "--port", String(port), ...extra], {
    cwd: project,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  let output = "";
  const record = (chunk: Buffer): void => {
    output += chunk.toString();
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  const candidates = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  let url = "";
  const answers = async (): Promise<boolean> => {
    for (const candidate of candidates) {
      const answered = await fetch(candidate).then(
        () => true,
        () => false,
      );
      if (answered) {
        url = candidate;
        return true;
      }
    }
    return false;
  };
  await until(
    answers,
    () => `the dev server never answered on ${port} (exit ${child.exitCode}):\n${output}`,
    90_000,
  ).catch(async (error: Error) => {
    await stop(child);
    throw error;
  });
  return { url, stop: () => stop(child) };
};

const freePort = (): Promise<number> =>
  new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => done(port));
    });
  });

/** React renders a comment between adjacent expressions; the text reads as written without them. */
const rendered = async (response: Response): Promise<string> =>
  (await response.text()).replaceAll(/<!--.*?-->/g, "");

afterAll(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

describe("a project created by create-bounda", () => {
  it("generates, type-checks and passes its own test", async () => {
    const project = await scaffold(["shop", "--yes", "--no-git", "--no-install"], "node");

    const generated = await run(
      process.execPath,
      [join(project, "node_modules/@bounda-dev/cli/dist/cli.js"), "generate"],
      { cwd: project },
    );
    expect(generated.stdout).toMatch(/1 aggregate, 1 read model, \d+ files/);

    await run(join(repoRoot, "node_modules/.bin/tsc"), ["--noEmit", "-p", "tsconfig.json"], {
      cwd: project,
    });

    const tested = await run(
      process.execPath,
      [join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", "--root", project],
      { cwd: project, env: { ...process.env, CI: "1" } },
    );
    expect(`${tested.stdout}${tested.stderr}`).toMatch(/1 passed/);
  }, 180_000);

  it("scaffolds a React Router app that generates, type-checks, tests, builds and serves", async () => {
    const project = await scaffold(
      ["web", "--framework", "react-router", "--yes", "--no-git", "--no-install"],
      "react-router",
    );
    const reactRouter = join(project, "node_modules/@react-router/dev/bin.cjs");

    await run(
      process.execPath,
      [join(project, "node_modules/@bounda-dev/cli/dist/cli.js"), "generate"],
      { cwd: project },
    );
    await run(process.execPath, [reactRouter, "typegen"], { cwd: project });
    await run(join(repoRoot, "node_modules/.bin/tsc"), ["--noEmit", "-p", "tsconfig.json"], {
      cwd: project,
    });
    const tested = await run(
      process.execPath,
      [join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", "--root", project],
      { cwd: project, env: { ...process.env, CI: "1" } },
    );
    expect(`${tested.stdout}${tested.stderr}`).toMatch(/1 passed/);
    const built = await run(process.execPath, [reactRouter, "build"], { cwd: project });
    expect(`${built.stdout}${built.stderr}`).toMatch(/built in/);

    const server = await devServer(project, reactRouter);
    try {
      const home = await fetch(`${server.url}/`);
      expect(home.status).toBe(200);
      expect(await rendered(home)).toContain("ada: 0 order(s), 0 in total");

      const placed = await fetch(`${server.url}/?index`, {
        method: "POST",
        body: new URLSearchParams({ customerId: "grace", total: "99" }),
        redirect: "manual",
      });
      expect(placed.status).toBe(302);
      expect(placed.headers.get("location")).toContain("/?customer=grace");

      const grace = await fetch(`${server.url}/?customer=grace`);
      expect(await rendered(grace)).toContain("grace: 1 order(s), 99 in total");
    } finally {
      await server.stop();
    }
  }, 300_000);

  it("scaffolds a Cloudflare app that generates, type-checks, tests and serves its store", async () => {
    const project = await scaffold(
      ["edge", "--framework", "cloudflare", "--yes", "--no-git", "--no-install"],
      "cloudflare",
    );
    expect(await readFile(join(project, "bounda.config.ts"), "utf8")).toContain("cloudflare()");
    expect(await readFile(join(project, "wrangler.jsonc"), "utf8")).toContain('"name": "edge"');

    await run(
      process.execPath,
      [join(project, "node_modules/@bounda-dev/cli/dist/cli.js"), "generate"],
      { cwd: project },
    );
    await run(join(repoRoot, "node_modules/.bin/tsc"), ["--noEmit", "-p", "tsconfig.json"], {
      cwd: project,
    });
    const tested = await run(
      process.execPath,
      [join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", "--root", project],
      { cwd: project, env: { ...process.env, CI: "1" } },
    );
    expect(`${tested.stdout}${tested.stderr}`).toMatch(/1 passed/);

    const server = await devServer(
      project,
      join(project, "node_modules/wrangler/bin/wrangler.js"),
      ["--ip", "127.0.0.1"],
    );
    const post = (path: string, body: unknown) =>
      fetch(`${server.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bounda-tenant": "acme" },
        body: JSON.stringify(body),
      });
    try {
      const page = await fetch(`${server.url}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("<title>Bounda on Cloudflare</title>");
      const placed = await post("/commands/placeOrder", {
        orderId: "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01",
        customerId: "ada",
        total: 42,
      });
      expect(placed.status).toBe(200);
      expect(await placed.json()).toMatchObject({ scheduled: false, version: 1 });
      const listed = await post("/queries/listOrders", { customerId: "ada" });
      expect(await listed.json()).toMatchObject({ total: 42 });
      const refused = await post("/commands/placeOrder", {
        orderId: "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01",
        customerId: "ada",
        total: 1,
      });
      expect(refused.status).toBe(409);
    } finally {
      await server.stop();
    }
  }, 300_000);
});
