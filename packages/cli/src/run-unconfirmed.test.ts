import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { EXIT_OK, runCli } from "./run.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    watch: async function* (
      _path: string,
      options: { readonly signal?: AbortSignal },
    ): AsyncGenerator<never> {
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  };
});

const temporary: string[] = [];

afterAll(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

const capture = () => {
  const chunks: string[] = [];
  return {
    text: () => chunks.join(""),
    write: (text: string) => {
      chunks.push(text);
    },
  };
};

it("warns when the file system reports no change, and still generates and watches", async () => {
  const root = await mkdtemp(join(tmpdir(), "bounda-cli-"));
  temporary.push(root);
  await mkdir(join(root, "app/domain"), { recursive: true });
  const controller = new AbortController();
  const stdout = capture();
  const stderr = capture();
  const running = runCli({
    argv: ["generate", "--no-infer", "--watch"],
    cwd: root,
    stdout,
    stderr,
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(stdout.text()).toContain("watching app/ for changes"), {
    timeout: 5_000,
  });
  expect(stderr.text()).toBe(
    "warning: the file system has not reported a change under app/; watching may miss changes\n",
  );
  await stat(join(root, ".bounda/registry.ts"));
  controller.abort();
  expect(await running).toBe(EXIT_OK);
}, 15_000);
