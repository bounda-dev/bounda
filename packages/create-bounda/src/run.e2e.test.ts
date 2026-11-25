import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify, stripVTControlCharacters } from "node:util";
import { startContainer } from "@bounda-dev/test-containers";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, describe, expect, it } from "vitest";
import type { Database, Framework, Runtime } from "./options.ts";
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
  readonly database?: Database;
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
    stack.runtime === "cloudflare" ? "cloudflare" : (stack.database ?? "sqlite"),
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
  // What the server printed so far, both streams.
  readonly output: () => string;
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
 * Readiness is a request that answers while the server's own process group listens on the port,
 * not a line in the log: the banner's wording is Vite's to change. The command makes the server
 * listen on 127.0.0.1 and exit rather than move when the port is taken, so the port found free is
 * the one it listens on. Between finding it and binding it another process can take it, and answer
 * before the server exits, as a Worker's inspector once did with a 403; a server that then exits on
 * a port found busy means exactly that, so it tries another. Any other exit fails with what the
 * server printed. A request is dropped when the server exits or the deadline passes: whatever held
 * the port may accept the connection and never answer.
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
    const ours = async (): Promise<boolean> =>
      (await answers()) && (await listeningGroups(port)).includes(child.pid ?? Number.NaN);
    await until(
      async () => exited() || (await ours()),
      () => `the server never answered on ${port}:\n${output}`,
      READY_WITHIN_MS,
    ).catch(async (error: Error) => {
      await stop(child);
      throw error;
    });
    if (!exited()) return { url, port, stop: () => stop(child), output: () => output };
    await stop(child);
    if (attempt < PORT_ATTEMPTS && (await portTaken(port))) continue;
    throw new Error(
      `the server exited (${child.exitCode ?? child.signalCode}) before answering on ${port}:\n${output}`,
    );
  }
};

// The process groups with a socket listening on `port`, as lsof lists them; it exits with 1 when
// there is none.
const listeningGroups = async (port: number): Promise<readonly number[]> => {
  const { stdout } = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-g", "-Fg"]).catch(
    (error: { readonly code?: unknown }) => {
      if (error.code === 1) return { stdout: "" };
      if (error.code === "ENOENT") {
        throw new Error(
          "this test needs lsof, which tells the server it starts from another process on its port",
          { cause: error },
        );
      }
      throw error;
    },
  );
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("g"))
    .map((line) => Number(line.slice(1)));
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

interface ForgetsAgainAfterRestoreArgs {
  readonly project: string;
  readonly env: NodeJS.ProcessEnv;
  readonly backUp: () => Promise<unknown>;
  readonly restore: () => Promise<unknown>;
}

/**
 * A backup restored with the app stopped forgets again whoever was forgotten after it was taken:
 * the forget ledger, apart from the database, tells the next start. Grace's delivery note is
 * sealed under her key, which the backup holds and the forgetting destroys.
 */
const forgetsAgainAfterRestore = async ({
  project,
  env,
  backUp,
  restore,
}: ForgetsAgainAfterRestoreArgs): Promise<void> => {
  const cli = join(project, "node_modules/@bounda-dev/cli/dist/cli.js");
  const bounda = (...args: readonly string[]) =>
    run(process.execPath, [cli, ...args], { cwd: project, env });
  const note = "Leave it with the porter";
  await run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { boot } from "@bounda-dev/core/node";
const app = await boot({ signals: false });
await app.commands.placeOrder({ orderId: crypto.randomUUID(), customerId: "grace", total: 7, deliveryNote: ${JSON.stringify(note)} });
await app.runUntilIdle();
await app.stop();`,
    ],
    { cwd: project, env },
  );
  expect((await bounda("personal-data", "export", "grace")).stdout).toContain(note);
  await backUp();
  expect((await bounda("forget", "grace")).stdout).toContain("forgot grace");
  await restore();
  expect((await bounda("forgotten", "--since", "0")).stdout).not.toContain('"grace"');
  const exported = await bounda("personal-data", "export", "grace");
  expect(exported.stderr).toContain("committed again forgettings the database did not hold");
  expect(exported.stdout).not.toContain(note);
  expect((await bounda("forgotten", "--since", "0")).stdout).toContain('"personId":"grace"');
};

interface HandsBackAndForgetsTenantArgs {
  readonly project: string;
  readonly env: NodeJS.ProcessEnv;
  // How many rows the forget ledger's table holds, of every tenant.
  readonly ledgerRows: () => Promise<number>;
}

/**
 * The app run without a tenant, as the script and `boot()` run it, and the CLI given `default`
 * serve one tenant: the export of `default` hands back the forget ledger the app wrote, and its
 * forgetting clears it, once the next start tells its recipients.
 */
const handsBackAndForgetsTenant = async ({
  project,
  env,
  ledgerRows,
}: HandsBackAndForgetsTenantArgs): Promise<void> => {
  const cli = join(project, "node_modules/@bounda-dev/cli/dist/cli.js");
  const bounda = (...args: readonly string[]) =>
    run(process.execPath, [cli, ...args], { cwd: project, env });
  expect(await ledgerRows()).toBeGreaterThan(0);
  expect((await bounda("freeze-tenant", "default")).stdout).toContain("froze tenant default");
  const file = join(project, "default.jsonl");
  const exported = await bounda("export-tenant", "default", "--output", file);
  expect(exported.stderr).toMatch(/exported tenant default to .*, [1-9]\d* forget ledger entries;/);
  const entries = (await readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { kind: string; entry?: { personId: string } })
    .filter(({ kind }) => kind === "forgetLedgerEntry");
  expect(entries.map(({ entry }) => entry?.personId)).toContain("grace");
  expect((await bounda("check-tenant-export", file)).stdout).toContain(
    "is a whole export of tenant default",
  );
  expect((await bounda("forget-tenant", "default", "--yes")).stdout).toContain(
    "forgot tenant default",
  );
  await run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { boot } from "@bounda-dev/core/node";
const app = await boot({ signals: false });
await app.runUntilIdle();
console.log(JSON.stringify((await app.status()).forgottenTenant));
await app.stop();`,
    ],
    { cwd: project, env },
  ).then(({ stdout }) =>
    expect(JSON.parse(stdout.trim().split("\n").at(-1) as string)).toMatchObject({
      recipientsTold: true,
      forgetLedgerCleared: true,
    }),
  );
  expect(await ledgerRows()).toBe(0);
};

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
    // The record of processing is complete, and says where every database keeps the data.
    const inventory = await run(
      process.execPath,
      [
        join(project, "node_modules/@bounda-dev/cli/dist/cli.js"),
        "personal-data",
        "inventory",
        "--json",
      ],
      { cwd: project },
    );
    expect(JSON.parse(inventory.stdout)).toMatchObject({
      records: expect.arrayContaining([
        { name: "persons", where: "sqlite", location: "eu", transfer: null, keptFor: null },
        { name: "master-key", where: "key-wrapper", location: "eu", transfer: null, keptFor: null },
        {
          name: "tenant-keys",
          where: "tenant-keys",
          location: "eu",
          transfer: null,
          keptFor: null,
        },
        {
          name: "forget-ledger",
          where: "forget-ledger",
          location: "eu",
          transfer: null,
          keptFor: null,
        },
      ]),
      findings: [],
    });

    await run(join(repoRoot, "node_modules/.bin/tsc"), ["--noEmit", "-p", "tsconfig.json"], {
      cwd: project,
    });

    const tested = await run(
      process.execPath,
      [join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", "--root", project],
      { cwd: project, env: { ...process.env, CI: "1" } },
    );
    expect(stripVTControlCharacters(`${tested.stdout}${tested.stderr}`)).toMatch(
      /Tests\s+2 passed/,
    );

    // The script boots on the master key create-bounda wrote into `.env`.
    expect(await readFile(join(project, ".env"), "utf8")).toMatch(
      /^BOUNDA_MASTER_KEY=[A-Za-z0-9+/]{43}=$/m,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== "BOUNDA_MASTER_KEY"),
    );
    const started = await run(process.execPath, ["src/main.ts"], { cwd: project, env });
    expect(started.stdout).toContain("1 order(s) for ada, 42 in total");

    // The forget ledger, in a file of its own, outlives a copy of the database put back in place.
    const database = join(project, "data/app.db");
    const backup = join(project, "backup.db");
    await forgetsAgainAfterRestore({
      project,
      env,
      backUp: () => copyFile(database, backup),
      restore: () => copyFile(backup, database),
    });
    await handsBackAndForgetsTenant({
      project,
      env,
      ledgerRows: async () => {
        const ledger = new DatabaseSync(join(project, "ledger/forget-ledger.db"));
        try {
          return Number(
            ledger.prepare('SELECT count(*) AS "rows" FROM "bounda_forget_ledger"').get()?.rows,
          );
        } finally {
          ledger.close();
        }
      },
    });

    // Without the master key in `.env`, the script refuses to boot.
    await rm(join(project, ".env"));
    await expect(run(process.execPath, ["src/main.ts"], { cwd: project, env })).rejects.toThrow(
      /The environment variable BOUNDA_MASTER_KEY, which runtime\.personalData\.keyWrapper names as a master key, is not set/,
    );
  }, 180_000);

  it("scaffolds a PostgreSQL project that generates, type-checks, tests and forgets again after a restore", async (context) => {
    const project = await scaffold(
      ["depot", "--database", "postgresql", "--yes", "--no-git", "--no-install"],
      { runtime: "node", framework: "none", database: "postgresql" },
    );
    const cli = join(project, "node_modules/@bounda-dev/cli/dist/cli.js");
    await run(process.execPath, [cli, "generate"], { cwd: project });
    // The record of processing reads the configuration without reaching a server: each store
    // apart from the database, every one in the same place.
    const nowhere = "postgres://bounda@127.0.0.1:1";
    const inventory = await run(process.execPath, [cli, "personal-data", "inventory", "--json"], {
      cwd: project,
      env: {
        ...process.env,
        DATABASE_URL: `${nowhere}/depot`,
        TENANT_KEYS_URL: `${nowhere}/depot_keys`,
        FORGET_LEDGER_URL: `${nowhere}/depot_ledger`,
      },
    });
    expect(JSON.parse(inventory.stdout)).toMatchObject({
      records: expect.arrayContaining([
        { name: "persons", where: "postgresql", location: "eu", transfer: null, keptFor: null },
        { name: "master-key", where: "key-wrapper", location: "eu", transfer: null, keptFor: null },
        {
          name: "tenant-keys",
          where: "tenant-keys",
          location: "eu",
          transfer: null,
          keptFor: null,
        },
        {
          name: "forget-ledger",
          where: "forget-ledger",
          location: "eu",
          transfer: null,
          keptFor: null,
        },
      ]),
      findings: [],
    });
    // Each database the configuration needs is named when it is missing.
    await expect(
      run(process.execPath, [cli, "personal-data", "inventory", "--json"], {
        cwd: project,
        env: {
          ...process.env,
          DATABASE_URL: `${nowhere}/depot`,
          TENANT_KEYS_URL: `${nowhere}/depot_keys`,
        },
      }),
    ).rejects.toThrow(/Set FORGET_LEDGER_URL, see \.env\.example/);

    await run(join(repoRoot, "node_modules/.bin/tsc"), ["--noEmit", "-p", "tsconfig.json"], {
      cwd: project,
    });
    const tested = await run(
      process.execPath,
      [join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", "--root", project],
      { cwd: project, env: { ...process.env, CI: "1" } },
    );
    expect(stripVTControlCharacters(`${tested.stdout}${tested.stderr}`)).toMatch(
      /Tests\s+2 passed/,
    );

    // On a server, as the adapter's own suite runs: skipped when Docker is not running outside
    // CI, and one server for every run under BOUNDA_PG_REUSE=1, each run on databases of its own.
    const definition = new PostgreSqlContainer("postgres:17");
    const reuse = process.env.BOUNDA_PG_REUSE === "1";
    const server = await startContainer(() =>
      (reuse ? definition.withReuse() : definition).start(),
    );
    if (server === null) return context.skip("Docker is not running");
    const storage = `shop_${randomUUID().replaceAll("-", "")}`;
    const databases = [storage, `${storage}_keys`, `${storage}_ledger`] as const;
    const dump = `/tmp/${storage}.dump`;
    const inServer = async (command: readonly string[]): Promise<void> => {
      const { exitCode, output } = await server.exec([...command]);
      expect(exitCode, output).toBe(0);
    };
    const user = server.getUsername();
    const psql = (statement: string) =>
      inServer(["psql", "-U", user, "-d", server.getDatabase(), "-c", statement]);
    try {
      for (const database of databases) await psql(`CREATE DATABASE ${database}`);
      const [storageUrl, keysUrl, ledgerUrl] = databases.map((database) => {
        const url = new URL(server.getConnectionUri());
        url.pathname = `/${database}`;
        return url.toString();
      });
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => name !== "BOUNDA_MASTER_KEY"),
        ),
        DATABASE_URL: storageUrl,
        TENANT_KEYS_URL: keysUrl,
        FORGET_LEDGER_URL: ledgerUrl,
      };
      const started = await run(process.execPath, ["src/main.ts"], { cwd: project, env });
      expect(started.stdout).toContain("1 order(s) for ada, 42 in total");
      // The forget ledger, in a database of its own, outlives a dump of the storage's restored.
      await forgetsAgainAfterRestore({
        project,
        env,
        backUp: () => inServer(["pg_dump", "-U", user, "--format", "custom", "-f", dump, storage]),
        restore: async () => {
          await psql(`DROP DATABASE ${storage} WITH (FORCE)`);
          await psql(`CREATE DATABASE ${storage}`);
          await inServer(["pg_restore", "-U", user, "-d", storage, dump]);
        },
      });
      await handsBackAndForgetsTenant({
        project,
        env,
        ledgerRows: async () => {
          const { exitCode, output } = await server.exec([
            "psql",
            "-U",
            user,
            "-d",
            `${storage}_ledger`,
            "-tAc",
            'SELECT count(*) FROM "bounda_forget_ledger"',
          ]);
          expect(exitCode, output).toBe(0);
          return Number(output.trim());
        },
      });
    } finally {
      if (reuse) {
        await inServer(["rm", "-f", dump]);
        for (const database of databases)
          await psql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      } else {
        await server.stop();
      }
    }
  }, 300_000);

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
    expect(stripVTControlCharacters(`${tested.stdout}${tested.stderr}`)).toMatch(
      /Tests\s+2 passed/,
    );
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

      // React Router hands what it throws to app/entry.server.tsx's handleError, which logs its
      // text in development.
      expect((await fetch(`${server.url}/nope/ana`)).status).toBe(404);
      await until(
        () =>
          /request failed \{"method":"GET","path":"\/nope\/ana","errorName":"Error","errorMessage":"No route matches URL/.test(
            server.output(),
          ),
        () => `the dev server did not log the error's text:\n${server.output()}`,
        10_000,
      );

      // An edited configuration reboots the app: here, on a database of its own, whose tenant's
      // key and forget ledger are apart from the first one's, as both belong to one database.
      expect(original).toContain("./data/app.db");
      expect(original).toContain("./keys/tenant-keys.db");
      expect(original).toContain("./ledger/forget-ledger.db");
      await writeFile(
        config,
        original
          .replace("./data/app.db", "./data/edited.db")
          .replace("./keys/tenant-keys.db", "./keys/edited.db")
          .replace("./ledger/forget-ledger.db", "./ledger/edited.db"),
      );
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

      // The build logs no text of an error: an error's message may quote personal data.
      expect((await fetch(`${production.url}/nope/ana`)).status).toBe(404);
      await until(
        () =>
          production
            .output()
            .includes('[bounda] error request failed {"method":"GET","errorName":"Error"}'),
        () => `the build did not log the error:\n${production.output()}`,
        10_000,
      );
      expect(production.output()).not.toContain("No route matches");
    } finally {
      await production.stop();
    }
  }, 300_000);

  it("scaffolds a Cloudflare app that generates, type-checks, tests and serves its store", async () => {
    const project = await scaffold(
      ["edge", "--runtime", "cloudflare", "--yes", "--no-git", "--no-install"],
      { runtime: "cloudflare", framework: "none" },
    );
    expect(await readFile(join(project, "bounda.config.ts"), "utf8")).toContain(
      `cloudflare({ jurisdiction: "eu" })`,
    );
    const wranglerConfig = await readFile(join(project, "wrangler.jsonc"), "utf8");
    expect(wranglerConfig).toContain('"name": "edge"');
    expect(wranglerConfig).toContain('{ "name": "KEEPER", "class_name": "Keeper" }');
    expect(wranglerConfig).not.toContain("kv_namespaces");
    expect(await readFile(join(project, ".dev.vars"), "utf8")).toMatch(
      /^BOUNDA_MASTER_KEY=[A-Za-z0-9+/]{43}=$/m,
    );

    await run(
      process.execPath,
      [join(project, "node_modules/@bounda-dev/cli/dist/cli.js"), "generate"],
      { cwd: project },
    );
    // The record of processing reads the modules in Node, which import the Workers runtime, and
    // says where the objects keep the data.
    const inventory = await run(
      process.execPath,
      [
        join(project, "node_modules/@bounda-dev/cli/dist/cli.js"),
        "personal-data",
        "inventory",
        "--json",
      ],
      { cwd: project },
    );
    expect(JSON.parse(inventory.stdout)).toMatchObject({
      records: expect.arrayContaining([
        { name: "persons", where: "cloudflare", location: "eu", transfer: null, keptFor: null },
        { name: "master-key", where: "key-wrapper", location: "eu", transfer: null, keptFor: null },
        // In the keeper, in the same jurisdiction as the objects.
        {
          name: "forget-ledger",
          where: "forget-ledger",
          location: "eu",
          transfer: null,
          keptFor: null,
        },
      ]),
    });
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
    expect(stripVTControlCharacters(`${tested.stdout}${tested.stderr}`)).toMatch(
      /Tests\s+9 passed/,
    );

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

    // Without the secret the object refuses to start, saying which one, rather than store keys in
    // the clear; the Worker answers 500 without the reason, which it logs, with its text as
    // BOUNDA_ERROR_TEXT in .dev.vars says.
    await rename(join(project, ".dev.vars"), join(project, ".dev.vars.kept"));
    await writeFile(join(project, ".dev.vars"), "BOUNDA_ERROR_TEXT=include\n");
    const keyless = await startServer(project, {
      args: (port) => [wrangler, "dev", "--port", String(port), "--ip", "127.0.0.1"],
    });
    try {
      const placed = await fetch(`${keyless.url}/commands/placeOrder`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bounda-tenant": "acme" },
        body: JSON.stringify({
          orderId: "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e02",
          customerId: "ada",
          total: 1,
        }),
      });
      const answer = await placed.text();
      // What answered and what the server printed, should anything but the Worker answer.
      expect(placed.status, `${answer}\n${keyless.output()}`).toBe(500);
      expect(JSON.parse(answer)).toEqual({
        error: { code: "INTERNAL", message: "Internal error" },
      });
      await until(
        () =>
          /The environment variable BOUNDA_MASTER_KEY, which runtime\.personalData\.keyWrapper names as a master key, is not set/.test(
            keyless.output(),
          ),
        () => `the object's failure was not logged:\n${keyless.output()}`,
        10_000,
      );
      await until(
        () =>
          /"message":"bounda worker request failed","path":"\/commands\/placeOrder","errorName":"[^"]+","errorMessage":"[^"]*BOUNDA_MASTER_KEY/.test(
            keyless.output(),
          ),
        () => `the Worker did not log the failure's text:\n${keyless.output()}`,
        10_000,
      );
    } finally {
      await keyless.stop();
      await rename(join(project, ".dev.vars.kept"), join(project, ".dev.vars"));
    }
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
    expect(stripVTControlCharacters(`${tested.stdout}${tested.stderr}`)).toMatch(
      /Tests\s+5 passed/,
    );
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
    // React Router hands what it throws to app/entry.server.tsx's handleError, which logs it as
    // BOUNDA_ERROR_TEXT in .dev.vars says.
    const notFound = async (url: string, output: () => string, line: RegExp): Promise<void> => {
      expect((await fetch(`${url}/nope/ana`)).status).toBe(404);
      await until(
        () => line.test(output()),
        () => `the Worker did not log the error as expected:\n${output()}`,
        10_000,
      );
    };
    try {
      await placeAndList(server.url, "grace");
      await notFound(
        server.url,
        server.output,
        /"message":"bounda request failed","method":"GET","path":"\/nope\/ana","errorName":"Error","errorMessage":"No route matches URL/,
      );
    } finally {
      await server.stop();
    }
    expect(await portTaken(server.port)).toBe(false);

    // What `wrangler deploy` would upload: the Worker the build wrote, with its own wrangler.json,
    // here without BOUNDA_ERROR_TEXT, as a deployment has it.
    const devVars = join(project, ".dev.vars");
    const vars = await readFile(devVars, "utf8");
    expect(vars).toMatch(/^BOUNDA_ERROR_TEXT=include$/m);
    await writeFile(devVars, vars.replace(/^BOUNDA_ERROR_TEXT=.*$/m, ""));
    const production = await startServer(project, {
      args: (port) => [wrangler, "dev", "--port", String(port), "--ip", "127.0.0.1"],
    });
    try {
      await placeAndList(production.url, "lin");
      await notFound(
        production.url,
        production.output,
        /\{"level":"error","message":"bounda request failed","method":"GET","errorName":"Error"\}/,
      );
      expect(production.output()).not.toContain("No route matches");
    } finally {
      await production.stop();
      await writeFile(devVars, vars);
    }
  }, 300_000);
});
