import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONNECTION_HOLDER, closeConnectionsOnce } from "./close-once.ts";

const CLOSES = 20;

// Guard Malloc makes freed memory fault on macOS, so a second close of a connection crashes there
// every time; Windows faults on it now and then, and Linux not at all.
const GUARD_MALLOC = "/usr/lib/libgmalloc.dylib";
const FREED_MEMORY_FAULTS: NodeJS.ProcessEnv =
  process.platform === "darwin" && existsSync(GUARD_MALLOC)
    ? { DYLD_INSERT_LIBRARIES: GUARD_MALLOC }
    : {};

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bounda-close-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
    if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
  });
});

// Opens and closes storage on a file again and again, in a process of its own, each time once the
// statements it ran have been collected: then nothing but the connection's own handle holds it
// when the client closes. Each time it also drops a client in memory without closing it, whose
// connection is in the same state when collected. Resolves how the process ended.
const closeAfterCollecting = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--expose-gc",
        "--input-type=module",
        "-e",
        `import { setImmediate } from "node:timers/promises";
        import { createClient } from "@libsql/client";
        import { sqlite } from "./index.ts";
        const collect = async () => {
          for (let round = 0; round < 3; round += 1) {
            globalThis.gc();
            await setImmediate();
          }
        };
        for (let time = 0; time < ${CLOSES}; time += 1) {
          const storage = await sqlite({ path: ${JSON.stringify(path)} }).createStorage();
          await storage.eventStore.lastPosition();
          await createClient({ url: ":memory:" }).execute("SELECT 1");
          await collect();
          await storage.close();
        }
        await collect();`,
      ],
      {
        cwd: import.meta.dirname,
        env: { ...process.env, ...FREED_MEMORY_FAULTS },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let errors = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      errors += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve(code === 0 ? "exited" : `ended with ${signal ?? code}: ${errors.slice(-2000)}`);
    });
  });

describe("closing a libSQL file", () => {
  it("closes each connection once, closed or dropped, even when nothing but its own handle holds it", {
    timeout: 60_000,
  }, async () => {
    expect(await closeAfterCollecting(join(directory, "closed.db"))).toBe("exited");
  });
});

interface NativeStatement {
  get(): unknown;
}

interface NativeDatabase {
  readonly open: boolean;
  prepare(sql: string): NativeStatement;
  close(): void;
}

interface NativeDatabaseModule {
  new (path: string): NativeDatabase;
  readonly prototype: NativeDatabase;
}

const Database = createRequire(createRequire(import.meta.url).resolve("@libsql/client"))(
  "libsql",
) as NativeDatabaseModule;

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

const collect = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) {
    collectGarbage();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

describe("closing a libSQL connection", () => {
  it("closes it with a statement still holding the connection, so the native close only lets go", () => {
    closeConnectionsOnce();
    const database = new Database(":memory:");
    database.close();
    expect(database.open).toBe(false);
    const holder = Reflect.get(database, CONNECTION_HOLDER) as NativeStatement;
    expect(holder.get()).toMatchObject({ 1: 1 });
  });

  it("closes a closed connection again without preparing on it", () => {
    const database = new Database(":memory:");
    database.close();
    expect(() => database.close()).not.toThrow();
  });

  it("leaves a closed database to be collected without closing it again", async () => {
    closeConnectionsOnce();
    const errors: unknown[] = [];
    const record = (error: unknown): void => {
      errors.push(error);
    };
    process.on("uncaughtException", record);
    try {
      (() => {
        const database = new Database(":memory:");
        database.prepare("SELECT 1");
        database.close();
      })();
      await collect();
    } finally {
      process.off("uncaughtException", record);
    }
    expect(errors).toEqual([]);
  });

  it("patches the module once", () => {
    closeConnectionsOnce();
    const { close } = Database.prototype;
    closeConnectionsOnce();
    expect(Database.prototype.close).toBe(close);
  });
});
