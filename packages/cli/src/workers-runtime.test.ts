import { registerHooks } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { resolveWorkersRuntime, standInWorkersRuntime } from "./workers-runtime.ts";

vi.mock("node:module", async (original) => ({
  ...(await original<typeof import("node:module")>()),
  registerHooks: vi.fn(),
}));

const context = { conditions: [], importAttributes: {}, parentURL: undefined };

describe("resolveWorkersRuntime", () => {
  it("resolves the Workers runtime to a stand-in, and anything else as Node would", async () => {
    const passed: string[] = [];
    const next = (specifier: string) => {
      passed.push(specifier);
      return { url: `file:///${specifier}` };
    };
    const standIn = resolveWorkersRuntime("cloudflare:workers", context, next);
    expect(standIn).toMatchObject({ shortCircuit: true });
    expect(standIn.url).toMatch(/^data:text\/javascript,/);
    expect(passed).toEqual([]);
    expect(resolveWorkersRuntime("node:path", context, next)).toEqual({ url: "file:///node:path" });
    expect(passed).toEqual(["node:path"]);

    const runtime = (await import(/* @vite-ignore */ standIn.url)) as Record<string, unknown>;
    expect(Object.keys(runtime).sort()).toEqual([
      "DurableObject",
      "RpcStub",
      "RpcTarget",
      "WorkerEntrypoint",
      "WorkflowEntrypoint",
      "env",
      "waitUntil",
    ]);
    const { DurableObject } = runtime as {
      DurableObject: new (ctx: object, env: object) => object;
    };
    const ctx = {};
    const env = {};
    expect(new DurableObject(ctx, env)).toMatchObject({ ctx, env });
  });
});

describe("standInWorkersRuntime", () => {
  it("registers the hook once, however many commands of the process ask for it", () => {
    standInWorkersRuntime();
    standInWorkersRuntime();
    expect(vi.mocked(registerHooks).mock.calls).toEqual([[{ resolve: resolveWorkersRuntime }]]);
  });
});
