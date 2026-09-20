import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { watchProject } from "./watch.ts";

const temporary: string[] = [];

const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bounda-watch-"));
  temporary.push(root);
  await mkdir(join(root, "app/domain/order/+types"), { recursive: true });
  return root;
};

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (condition: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await settle(20);
};

afterAll(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

describe("watchProject", () => {
  it("runs onChange per burst, ignores +types, reports errors and stops on abort", async () => {
    const root = await project();
    let runs = 0;
    let shouldThrow = false;
    const errors: unknown[] = [];
    const controller = new AbortController();
    const watching = watchProject({
      root,
      signal: controller.signal,
      debounceMs: 50,
      onChange: async () => {
        runs += 1;
        if (shouldThrow) throw new Error("boom");
      },
      onError: (error) => errors.push(error),
    });
    await settle(150);

    await writeFile(join(root, "app/domain/order/a.ts"), "export {};\n");
    await writeFile(join(root, "app/domain/order/b.ts"), "export {};\n");
    await until(() => runs >= 1);
    await settle(300);
    const afterBurst = runs;
    expect(afterBurst).toBeGreaterThanOrEqual(1);

    await writeFile(join(root, "app/domain/order/+types/a.ts"), "export {};\n");
    await settle(300);
    expect(runs).toBe(afterBurst);

    shouldThrow = true;
    await writeFile(join(root, "app/domain/order/c.ts"), "export {};\n");
    await until(() => errors.length >= 1);
    expect(runs).toBeGreaterThan(afterBurst);
    expect(errors[0]).toEqual(new Error("boom"));

    controller.abort();
    await expect(watching).resolves.toBeUndefined();
  });
});
