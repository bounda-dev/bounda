import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => ({
  settings: [] as { local: boolean; wal: boolean }[],
  closeOnce: 0,
}));

vi.mock("./close-once.ts", async (actual) => ({
  ...(await actual<typeof import("./close-once.ts")>()),
  closeConnectionsOnce: () => {
    opened.closeOnce += 1;
  },
}));

vi.mock("./database.ts", async (actual) => {
  const module = await actual<typeof import("./database.ts")>();
  return {
    ...module,
    createSqliteDatabase: (
      ...args: Parameters<typeof module.createSqliteDatabase>
    ): ReturnType<typeof module.createSqliteDatabase> => {
      opened.settings.push(args[1]);
      return module.createSqliteDatabase(...args);
    },
  };
});

const { sqlite } = await import("./index.ts");

const root = await mkdtemp(join(tmpdir(), "bounda-medium-"));

afterAll(() => rm(root, { recursive: true, force: true }));

beforeEach(() => {
  opened.settings.length = 0;
  opened.closeOnce = 0;
});

describe("sqlite's medium", () => {
  it("closes a local database's connections at exit and runs its calls one at a time", async () => {
    const file = sqlite({ path: join(root, "app.db") });
    await file.schemaVersions();
    const memory = sqlite({ memory: true });
    await memory.schemaVersions();
    expect(opened.closeOnce).toBe(2);
    expect(opened.settings).toEqual([
      { local: true, wal: true },
      { local: true, wal: false },
    ]);
  });

  it("leaves a remote server's connections to the client, and its calls to the server", async () => {
    const remote = sqlite({ url: "http://127.0.0.1:9" });
    await remote.schemaVersions().catch(() => undefined);
    expect(opened.closeOnce).toBe(0);
    expect(opened.settings).toEqual([{ local: false, wal: false }]);
  });
});
