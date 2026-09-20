import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generate } from "../generate.ts";

const repoRoot = resolve(import.meta.dirname, "../../../../..");
const fixtureRoot = join(repoRoot, "packages/core/test-types/fixtures/order-app-inferred");
const updateGolden = process.env.UPDATE_GOLDEN === "1";
const temporary: string[] = [];

const listFiles = async (root: string): Promise<readonly string[]> => {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path));
    }
  };
  await walk(root);
  return found.sort();
};

const isGenerated = (path: string): boolean =>
  path.includes("/+types/") || path.startsWith(".bounda/");

/**
 * A fresh copy of the fixture's sources (no generated files) with a tsconfig that resolves
 * `@bounda-dev/core` to the repository's source, as a user project would through node_modules.
 */
const freshProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bounda-infer-"));
  temporary.push(root);
  await cp(join(fixtureRoot, "app"), join(root, "app"), {
    recursive: true,
    filter: (source) => !source.includes("/+types"),
  });
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        extends: join(repoRoot, "tsconfig.base.json"),
        compilerOptions: {
          isolatedDeclarations: false,
          declaration: false,
          types: [],
          paths: { "@bounda-dev/core": [join(repoRoot, "packages/core/src/index.ts")] },
        },
        include: ["."],
      },
      null,
      2,
    ),
  );
  return root;
};

afterAll(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

describe("generate with state inference (golden on order-app-inferred)", () => {
  it("infers the state of an aggregate without state.ts from its apply functions", async () => {
    const root = await freshProject();
    const report = await generate({ root });
    expect(report.removed).toEqual([]);
    expect(report.warnings).toEqual([
      {
        aggregate: "order",
        message: expect.stringMatching(
          /^field "cancellation" \(set by orderCancelled\) has a type that is not visible from \.bounda\/types\.ts \(.*Cancellation.*\); it is typed as unknown\. Export the type or add state\.ts$/,
        ),
      },
    ]);

    const generated = (await listFiles(root)).filter(isGenerated);
    if (updateGolden) {
      for (const file of generated) {
        await cp(join(root, file), join(fixtureRoot, file));
      }
    }
    expect(generated).toEqual((await listFiles(fixtureRoot)).filter(isGenerated));
    for (const file of generated) {
      expect(await readFile(join(root, file), "utf8"), file).toBe(
        await readFile(join(fixtureRoot, file), "utf8"),
      );
    }
    const types = await readFile(join(root, ".bounda/types.ts"), "utf8");
    expect(types).toContain(`export type OrderState = {
  readonly cancellation?: unknown;
  readonly customerId?: string;
  readonly lines?: readonly import("../app/domain/order/order-placed.ts").Line[];
  readonly paidWith?: "card" | "transfer";
  readonly placedAt?: Date;
  readonly status?: "cancelled" | "paid" | "placed";
};`);
  });

  it("writes nothing on a second run", async () => {
    const root = await freshProject();
    await generate({ root });
    const report = await generate({ root });
    expect(report.written).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(report.unchanged.length).toBeGreaterThan(0);
  });

  it("falls back to UnknownState with a warning when TypeScript cannot open the project", async () => {
    const root = await freshProject();
    const report = await generate({ root, tsconfigPath: join(root, "missing.json") });
    expect(report.warnings).toEqual([
      {
        aggregate: "order",
        message: expect.stringMatching(
          /State stays core\.UnknownState; add app\/domain\/order\/state\.ts to type it$/,
        ),
      },
    ]);
    const types = await readFile(join(root, ".bounda/types.ts"), "utf8");
    expect(types).toContain("export type OrderState = core.UnknownState;");
  });

  it("skips inference on request", async () => {
    const root = await freshProject();
    const report = await generate({ root, inferState: false });
    expect(report.warnings).toEqual([]);
    expect(await readFile(join(root, ".bounda/types.ts"), "utf8")).toContain(
      "export type OrderState = core.UnknownState;",
    );
  });

  it("removes +types files whose module is gone", async () => {
    const root = await freshProject();
    await generate({ root, inferState: false });
    await rm(join(root, "app/domain/order/commands/pay-order.ts"));
    const report = await generate({ root, inferState: false });
    expect(report.removed).toEqual([join(root, "app/domain/order/commands/+types/pay-order.ts")]);
    expect(report.written).toEqual([
      join(root, ".bounda/registry.ts"),
      join(root, ".bounda/types.ts"),
    ]);
  });
});
