import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  isGeneratedPath,
  removeOrphans,
  writeGeneratedFile,
  writeGeneratedFiles,
} from "./write.ts";

const temporary: string[] = [];

afterAll(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

describe("writeGeneratedFile", () => {
  it("writes only when the content changed and refuses paths outside +types and .bounda", async () => {
    const root = await mkdtemp(join(tmpdir(), "bounda-write-"));
    temporary.push(root);
    const generated = join(root, "app/domain/order/+types/order-placed.ts");
    expect(await writeGeneratedFile(generated, "a")).toBe("written");
    expect(await writeGeneratedFile(generated, "a")).toBe("unchanged");
    expect(await writeGeneratedFile(generated, "b")).toBe("written");
    expect(await readFile(generated, "utf8")).toBe("b");
    expect(
      await writeGeneratedFiles([{ path: join(root, ".bounda/types.ts"), content: "x" }]),
    ).toEqual({
      written: [join(root, ".bounda/types.ts")],
      unchanged: [],
    });

    const userModule = join(root, "app/domain/order/order-placed.ts");
    await expect(writeGeneratedFile(userModule, "clobbered")).rejects.toThrow(
      /refusing to write .*order-placed\.ts: only \+types and \.bounda files are generated/,
    );
    expect(await stat(userModule).catch(() => null)).toBeNull();
  });

  it("recognises generated paths by their directory, not their name", () => {
    expect(isGeneratedPath("/p/app/+types/x.ts")).toBe(true);
    expect(isGeneratedPath("/p/.bounda/registry.ts")).toBe(true);
    expect(isGeneratedPath("/p/app/+types.ts")).toBe(false);
    expect(isGeneratedPath("/p/app/order-placed.ts")).toBe(false);
  });
});

describe("removeOrphans", () => {
  const exists = (path: string): Promise<boolean> =>
    stat(path).then(
      () => true,
      () => false,
    );

  it("removes generated files nobody keeps, drops emptied +types directories and leaves the rest", async () => {
    const root = await mkdtemp(join(tmpdir(), "bounda-orphans-"));
    temporary.push(root);
    const app = join(root, "app");
    await mkdir(join(app, "domain/order/+types"), { recursive: true });
    await mkdir(join(app, "domain/order/commands/+types"), { recursive: true });
    await mkdir(join(app, "read/orders/queries"), { recursive: true });
    await writeFile(join(app, "domain/order/+types/order-placed.ts"), "");
    await writeFile(join(app, "domain/order/+types/gone.ts"), "");
    await writeFile(join(app, "domain/order/commands/+types/stale.ts"), "");
    await writeFile(join(app, "domain/order/order-placed.ts"), "");
    await writeFile(join(app, "read/orders/queries/get.ts"), "");

    const removed = await removeOrphans({
      appDirectory: app,
      keep: new Set([join(app, "domain/order/+types/order-placed.ts")]),
    });
    expect(removed).toEqual([
      join(app, "domain/order/+types/gone.ts"),
      join(app, "domain/order/commands/+types/stale.ts"),
    ]);
    expect(await exists(join(app, "domain/order/+types/order-placed.ts"))).toBe(true);
    expect(await exists(join(app, "domain/order/+types"))).toBe(true);
    expect(await exists(join(app, "domain/order/commands/+types"))).toBe(false);
    expect(await exists(join(app, "domain/order/order-placed.ts"))).toBe(true);
    expect(await exists(join(app, "read/orders/queries/get.ts"))).toBe(true);
  });

  it("returns nothing for a directory that does not exist", async () => {
    expect(
      await removeOrphans({ appDirectory: join(tmpdir(), "nowhere-bounda"), keep: new Set() }),
    ).toEqual([]);
  });
});
