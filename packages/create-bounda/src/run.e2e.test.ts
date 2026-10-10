import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { Framework, Runtime } from "./options.ts";
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

interface Stack {
  readonly runtime: Runtime;
  readonly framework: Framework;
}

const REACT_ROUTER_TOOLS = [
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
];

/**
 * The tools the template declares, taken from this package's own dev dependencies: the same
 * versions it writes into the generated manifest.
 */
const linkTools = async (project: string, { runtime, framework }: Stack): Promise<void> => {
  const modules = join(project, "node_modules");
  const own = join(repoRoot, "packages/create-bounda/node_modules");
  const tools = [
    "typescript",
    "@types/node",
    "vitest",
    ...(runtime === "cloudflare" ? ["wrangler", "@cloudflare/vitest-plugin"] : []),
    ...(framework === "react-router" ? REACT_ROUTER_TOOLS : []),
    ...(runtime === "cloudflare" && framework === "react-router"
      ? ["@cloudflare/vite-plugin"]
      : []),
  ];
  for (const name of tools) await link(join(own, name), join(modules, name));
};

const scaffold = async (argv: readonly string[], stack: Stack): Promise<string> => {
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
    stack.runtime === "cloudflare" ? "cloudflare" : "sqlite",
    ...(stack.framework === "react-router" ? ["react-router"] : []),
  ]);
  await linkTools(project, stack);
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

const GROUP_GONE = new Set(["ESRCH", "EPERM"]);

const signalGroup = (pid: number, name: NodeJS.Signals | 0): boolean => {
  try {
    process.kill(-pid, name);
    return true;
  } catch (error) {
    if (GROUP_GONE.has((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
};

/**
 * The whole group, and until it is gone: `react-router dev` relaunches itself, so the listener
 * can outlive the child, and a group that has gone must not be signalled again. Gone is ESRCH, or
 * EPERM on macOS, which answers that way for a group whose only members are zombies not yet
 * reaped: every process in it is this test's, so no live one can refuse the signal.
 */
const stop = async (child: ChildProcess): Promise<void> => {
  const { pid } = child;
  if (pid === undefined || !signalGroup(pid, "SIGTERM")) return;
  const gone = (): boolean => !signalGroup(pid, 0);
  await until(gone, () => "", 3_000).catch(async () => {
    signalGroup(pid, "SIGKILL");
    await until(gone, () => `process group ${pid} outlived SIGKILL`, 5_000);
  });
};

const portTaken = (port: number): Promise<boolean> =>
  new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(true));
    server.listen(port, "127.0.0.1", () => server.close(() => done(false)));
  });

interface Server {
  readonly url: string;
  readonly port: number;
  readonly stop: () => Promise<void>;
}

/**
 * How to start a server on a port: its arguments to `node`, and what it adds to the environment.
 */
interface ServerCommand {
  readonly args: (port: number) => readonly string[];
  readonly env?: (port: number) => Readonly<Record<string, string>>;
}

const PORT_ATTEMPTS = 3;
const READY_WITHIN_MS = 90_000;

/**
 * The bug that made this test install tarballs only showed up in dev: the production build
 * resolved the app module through the plugin and succeeded while every request 500ed.
 *
 * Readiness is a request that answers, not a line in the log: the banner's wording is Vite's to
 * change. The command makes the server listen on 127.0.0.1 and exit rather than move when the
 * port is taken, so the port found free is the one it listens on. Between finding it and binding it
 * another process can take it; the server then exits, and a port found busy afterwards means
 * exactly that, so it tries another. Any other exit fails with what the server printed. A request
 * is dropped when the server exits or the deadline passes: whatever held the port may accept the
 * connection and never answer.
 */
const startServer = async (project: string, command: ServerCommand): Promise<Server> => {
  for (let attempt = 1; ; attempt += 1) {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [...command.args(port)], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
        ...command.env?.(port),
      },
    });
    let output = "";
    const record = (chunk: Buffer): void => {
      output += chunk.toString();
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    const exit = new AbortController();
    child.once("exit", () => exit.abort());
    const exited = (): boolean => exit.signal.aborted;
    const request = AbortSignal.any([exit.signal, AbortSignal.timeout(READY_WITHIN_MS)]);
    const answers = (): Promise<boolean> =>
      fetch(url, { signal: request }).then(
        () => true,
        () => false,
      );
    await until(
      async () => exited() || (await answers()),
      () => `the server never answered on ${port}:\n${output}`,
      READY_WITHIN_MS,
    ).catch(async (error: Error) => {
      await stop(child);
      throw error;
    });
    if (!exited()) return { url, port, stop: () => stop(child) };
    await stop(child);
    if (attempt < PORT_ATTEMPTS && (await portTaken(port))) continue;
    throw new Error(
      `the server exited (${child.exitCode ?? child.signalCode}) before answering on ${port}:\n${output}`,
    );
  }
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
    const project = await scaffold(["shop", "--yes", "--no-git", "--no-install"], {
      runtime: "node",
      framework: "none",
    });

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
      { runtime: "node", framework: "react-router" },
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

    const server = await startServer(project, {
      args: (port) => [
        reactRouter,
        "dev",
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        "--strictPort",
      ],
    });
    const config = join(project, "bounda.config.ts");
    const original = await readFile(config, "utf8");
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

      // An edited configuration reboots the app: here, on a database of its own.
      expect(original).toContain("./data/app.db");
      await writeFile(config, original.replace("./data/app.db", "./data/edited.db"));
      await until(
        async () =>
          (await rendered(await fetch(`${server.url}/?customer=grace`))).includes(
            "grace: 0 order(s)",
          ),
        () => "the dev server kept the configuration it booted with",
      );
    } finally {
      await server.stop();
      await writeFile(config, original);
    }
    expect(await portTaken(server.port)).toBe(false);

    // The build runs wherever it is deployed: nothing points back at where it was built.
    const deployed = `${project}-deployed`;
    await rename(project, deployed);
    const production = await startServer(deployed, {
      args: () => [
        join(deployed, "node_modules/@react-router/serve/bin.cjs"),
        "./build/server/index.js",
      ],
      env: (port) => ({ PORT: String(port), HOST: "127.0.0.1" }),
    });
    try {
      const grace = await fetch(`${production.url}/?customer=grace`);
      expect(grace.status).toBe(200);
      expect(await rendered(grace)).toContain("grace: 1 order(s), 99 in total");
    } finally {
      await production.stop();
    }
  }, 300_000);

  it("scaffolds a Cloudflare app that generates, type-checks, tests and serves its store", async () => {
    const project = await scaffold(
      ["edge", "--runtime", "cloudflare", "--yes", "--no-git", "--no-install"],
      { runtime: "cloudflare", framework: "none" },
    );
    expect(await readFile(join(project, "bounda.config.ts"), "utf8")).toContain("cloudflare()");
    expect(await readFile(join(project, "wrangler.jsonc"), "utf8")).toContain('"name": "edge"');

    await run(
      process.execPath,
      [join(project, "node_modules/@bounda-dev/cli/dist/cli.js"), "generate"],
      { cwd: project },
    );
    const wrangler = join(project, "node_modules/wrangler/bin/wrangler.js");
    await run(process.execPath, [wrangler, "types"], { cwd: project });
    await run(join(repoRoot, "node_modules/.bin/tsc"), ["--noEmit", "-p", "tsconfig.json"], {
      cwd: project,
    });
    const tested = await run(
      process.execPath,
      [join(project, "node_modules/vitest/vitest.mjs"), "run", "--root", project],
      { cwd: project, env: { ...process.env, CI: "1" } },
    );
    expect(`${tested.stdout}${tested.stderr}`).toMatch(/7 passed/);

    const server = await startServer(project, {
      args: (port) => [wrangler, "dev", "--port", String(port), "--ip", "127.0.0.1"],
    });
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
    expect(await portTaken(server.port)).toBe(false);
  }, 300_000);

  it("scaffolds a React Router app on Cloudflare that generates, type-checks, tests, builds and serves", async () => {
    const project = await scaffold(
      [
        "web-edge",
        "--runtime",
        "cloudflare",
        "--framework",
        "react-router",
        "--yes",
        "--no-git",
        "--no-install",
      ],
      { runtime: "cloudflare", framework: "react-router" },
    );
    expect(await readFile(join(project, "app/tenant.ts"), "utf8")).toContain('() => "default"');
    const reactRouter = join(project, "node_modules/@react-router/dev/bin.cjs");
    const wrangler = join(project, "node_modules/wrangler/bin/wrangler.js");

    await run(
      process.execPath,
      [join(project, "node_modules/@bounda-dev/cli/dist/cli.js"), "generate"],
      { cwd: project },
    );
    await run(process.execPath, [wrangler, "types"], { cwd: project });
    await run(process.execPath, [reactRouter, "typegen"], { cwd: project });
    await run(join(repoRoot, "node_modules/.bin/tsc"), ["--noEmit", "-p", "tsconfig.json"], {
      cwd: project,
    });
    const tested = await run(
      process.execPath,
      [join(project, "node_modules/vitest/vitest.mjs"), "run", "--root", project],
      { cwd: project, env: { ...process.env, CI: "1" } },
    );
    expect(`${tested.stdout}${tested.stderr}`).toMatch(/3 passed/);
    const built = await run(process.execPath, [reactRouter, "build"], { cwd: project });
    expect(`${built.stdout}${built.stderr}`).toMatch(/built in/);

    const placeAndList = async (url: string, customerId: string): Promise<void> => {
      const home = await fetch(`${url}/?customer=${customerId}`);
      expect(home.status).toBe(200);
      expect(await rendered(home)).toContain(`${customerId}: 0 order(s), 0 in total`);
      const placed = await fetch(`${url}/?index`, {
        method: "POST",
        body: new URLSearchParams({ customerId, total: "99" }),
        redirect: "manual",
      });
      expect(placed.status).toBe(302);
      expect(placed.headers.get("location")).toContain(`/?customer=${customerId}`);
      const listed = await fetch(`${url}/?customer=${customerId}`);
      expect(await rendered(listed)).toContain(`${customerId}: 1 order(s), 99 in total`);
    };

    const server = await startServer(project, {
      args: (port) => [
        reactRouter,
        "dev",
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        "--strictPort",
      ],
    });
    try {
      await placeAndList(server.url, "grace");
    } finally {
      await server.stop();
    }
    expect(await portTaken(server.port)).toBe(false);

    // What `wrangler deploy` would upload: the Worker the build wrote, with its own wrangler.json.
    const production = await startServer(project, {
      args: (port) => [wrangler, "dev", "--port", String(port), "--ip", "127.0.0.1"],
    });
    try {
      await placeAndList(production.url, "lin");
    } finally {
      await production.stop();
    }
  }, 300_000);
});
