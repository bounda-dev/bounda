import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { PersonalDataInventory } from "@bounda-dev/core";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixtureRoot = join(repoRoot, "packages/core/test-types/fixtures/order-app-inferred");
const temporary: string[] = [];
const run = promisify(execFile);

const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bounda-cli-e2e-"));
  temporary.push(root);
  await cp(join(fixtureRoot, "app"), join(root, "app"), {
    recursive: true,
    filter: (source) => basename(source) !== "+types",
  });
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      extends: join(repoRoot, "tsconfig.base.json"),
      compilerOptions: {
        isolatedDeclarations: false,
        declaration: false,
        types: [],
        paths: {
          "@bounda-dev/core": [join(repoRoot, "packages/core/src/index.ts")],
          "@bounda-dev/core/register": [join(repoRoot, "packages/core/src/register/index.ts")],
        },
      },
      include: [".", ".bounda/**/*"],
    }),
  );
  return root;
};

afterAll(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounda binary end to end", () => {
  it("runs from source and the generated project type-checks", async () => {
    const root = await project();
    const node = process.execPath;
    const { stdout } = await run(node, [join(repoRoot, "packages/cli/src/cli.ts"), "generate"], {
      cwd: root,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    expect(stdout).toContain("9 files (9 written");
    await run(
      process.execPath,
      [
        join(repoRoot, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "-p",
        join(root, "tsconfig.json"),
      ],
      {
        cwd: root,
      },
    );
  }, 60_000);

  it("keeps standard output to the result while the app writes to the console", async () => {
    const root = await mkdtemp(join(tmpdir(), "bounda-cli-e2e-"));
    temporary.push(root);
    const core = (path: string): string =>
      JSON.stringify(pathToFileURL(join(repoRoot, "packages/core/dist", path)).href);
    await writeFile(
      join(root, "bounda.config.ts"),
      [
        `import { defineConfig } from ${core("config/index.js")};`,
        `import { memory } from ${core("memory/index.js")};`,
        'console.log("the app writes to the console");',
        "export default defineConfig({ storage: memory() });",
      ].join("\n"),
    );
    const { stdout, stderr } = await run(
      process.execPath,
      [
        join(repoRoot, "packages/cli/src/cli.ts"),
        "dead-letters",
        "list",
        "--json",
        "--registry",
        join(import.meta.dirname, "fixtures/rebuild-project/.bounda/registry.ts"),
      ],
      { cwd: root, env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    expect(JSON.parse(stdout)).toEqual([]);
    expect(stderr).toContain("the app writes to the console\n");
    expect(stderr).toContain("[bounda] info bounda app created");
    expect(stderr).toContain("[bounda] info personal data accessed");
  }, 60_000);

  it("prints the record of a Cloudflare project, whose modules import the Workers runtime, and where its objects keep the data", async () => {
    const { stdout } = await run(
      process.execPath,
      [join(repoRoot, "packages/cli/src/cli.ts"), "personal-data", "inventory", "--json"],
      {
        cwd: join(repoRoot, "packages/cli/src/fixtures/cloudflare-project"),
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );
    const { holders, records } = JSON.parse(stdout) as PersonalDataInventory;
    expect(new Set(holders.map(({ database, location }) => `${database}, ${location}`))).toEqual(
      new Set(["cloudflare, eu"]),
    );
    expect(records.find(({ name }) => name === "persons")).toMatchObject({
      where: "cloudflare",
      location: "eu",
    });
  }, 60_000);

  it("says where a Cloudflare project's tenant keys are rewrapped, since a terminal reaches no keeper or KV namespace", async () => {
    const rewrap = (config: string) =>
      run(
        process.execPath,
        [
          join(repoRoot, "packages/cli/src/cli.ts"),
          "tenant-key",
          "rewrap-master",
          "--config",
          config,
        ],
        {
          cwd: join(repoRoot, "packages/cli/src/fixtures/cloudflare-project"),
          env: {
            ...process.env,
            NODE_NO_WARNINGS: "1",
            BOUNDA_MASTER_KEY: "5hmVukCECFtCyFw3rgVhT/y8hR2OrZBY5JonQlvHN1U=",
          },
        },
      );
    await expect(rewrap("bounda.keeper.config.ts")).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(
        "runtime.personalData.tenantKeys is kept in keeper Durable Objects, which only a Worker reaches, and this runs outside one: each tenant's key is rewrapped in its own Durable Object, which the scheduled handler of createWorker wakes",
      ),
    });
    await expect(rewrap("bounda.kv.config.ts")).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(
        "runtime.personalData.tenantKeys names the KV binding TENANT_KEYS, which only a Worker holds, and this runs outside one: each tenant's key is rewrapped in its own Durable Object",
      ),
    });
    // The record of processing reads the keeper's stores without opening them.
    const { stdout } = await run(
      process.execPath,
      [
        join(repoRoot, "packages/cli/src/cli.ts"),
        "personal-data",
        "inventory",
        "--json",
        "--config",
        "bounda.keeper.config.ts",
      ],
      {
        cwd: join(repoRoot, "packages/cli/src/fixtures/cloudflare-project"),
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );
    expect((JSON.parse(stdout) as PersonalDataInventory).records).toContainEqual({
      name: "forget-ledger",
      where: "forget-ledger",
      location: "eu",
      transfer: null,
      keptFor: null,
    });
  }, 60_000);

  it("loads a Cloudflare project to prune its forget ledger, and says why there is nothing to prune", async () => {
    const pruned = run(
      process.execPath,
      [
        join(repoRoot, "packages/cli/src/cli.ts"),
        "forget-ledger",
        "prune",
        "--config",
        "bounda.keeper.config.ts",
      ],
      {
        cwd: join(repoRoot, "packages/cli/src/fixtures/cloudflare-project"),
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );
    await expect(pruned).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(
        "error: Pruning the forget ledger needs runtime.personalData.forgetLedger.keepFor",
      ),
    });
  }, 60_000);

  it("refuses the record of a Cloudflare project the app would refuse to start", async () => {
    const refused = run(
      process.execPath,
      [
        join(repoRoot, "packages/cli/src/cli.ts"),
        "personal-data",
        "inventory",
        "--config",
        "bounda.mismatched.config.ts",
      ],
      {
        cwd: join(repoRoot, "packages/cli/src/fixtures/cloudflare-project"),
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );
    await expect(refused).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(
        "The read model customers lives in the tenant's Durable Object, in the jurisdiction storage names",
      ),
    });
  }, 60_000);
});
