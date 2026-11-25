import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CONNECTION_HOLDER,
  closeConnectionsLeftOpen,
  closeConnectionsOnce,
  type LibsqlNativeFromFunction,
  whereCodeRuns,
} from "./close-once.ts";

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

// Runs `script` in a process of its own, where freed memory faults when it can, and resolves how the
// process ended and what it printed.
const run = (script: string): Promise<{ readonly ended: string; readonly printed: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], {
      cwd: import.meta.dirname,
      env: { ...process.env, ...FREED_MEMORY_FAULTS },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let printed = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      printed += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      errors += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        ended: code === 0 ? "exited" : `ended with ${signal ?? code}: ${errors.slice(-2000)}`,
        printed,
      });
    });
  });

// Opens and closes storage on a file again and again, each time once the statements it ran have
// been collected: then nothing but the connection's own handle holds it when the client closes.
// Each time it also drops a client in memory without closing it, whose connection is in the same
// state when collected.
const closeAfterCollecting = async (path: string): Promise<string> =>
  (
    await run(`import { setImmediate } from "node:timers/promises";
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
    await collect();`)
  ).ended;

// Exits with storage open on a file, a client in memory dropped without closing it, and a database
// left open, which an exit listener added after the patch's own finds closed and closes again.
const exitWithConnectionsOpen = (path: string) =>
  run(`import { writeSync } from "node:fs";
  import { createRequire } from "node:module";
  import { createClient } from "@libsql/client";
  import { sqlite } from "./index.ts";
  const Database = createRequire(createRequire(import.meta.url).resolve("@libsql/client"))("libsql");
  const storage = await sqlite({ path: ${JSON.stringify(path)} }).createStorage();
  await storage.eventStore.lastPosition();
  await createClient({ url: ":memory:" }).execute("SELECT 1");
  globalThis.gc();
  const left = new Database(":memory:");
  left.prepare("SELECT 1");
  process.once("exit", () => {
    writeSync(1, left.open ? "left open" : "closed");
    left.close();
  });`);

describe("closing a libSQL file", () => {
  it("closes each connection once, closed or dropped, even when nothing but its own handle holds it", async () => {
    expect(await closeAfterCollecting(join(directory, "closed.db"))).toBe("exited");
  });

  it("closes each connection once as the process exits with it open", async () => {
    expect(await exitWithConnectionsOpen(join(directory, "left.db"))).toEqual({
      ended: "exited",
      printed: "closed",
    });
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

  it("leaves a database prepared on only once closed to be collected without closing it again", async () => {
    closeConnectionsOnce();
    const errors: unknown[] = [];
    const record = (error: unknown): void => {
      errors.push(error);
    };
    process.on("uncaughtException", record);
    try {
      (() => {
        const database = new Database(":memory:");
        database.close();
        expect(() => database.prepare("SELECT 1")).toThrow("not open");
      })();
      await collect();
    } finally {
      process.off("uncaughtException", record);
    }
    expect(errors).toEqual([]);
  });

  it("closes what is still open as the process exits, each once, the databases held themselves", async () => {
    closeConnectionsOnce();
    const held = new Database(":memory:");
    held.prepare("SELECT 1");
    const closed = new Database(":memory:");
    closed.prepare("SELECT 1");
    closed.close();
    // Only the handle of a database dropped unclosed, collected before its registry's callback runs.
    const handle = (() => {
      const dropped = new Database(":memory:");
      dropped.prepare("SELECT 1");
      return Reflect.get(dropped, "db");
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const errors: unknown[] = [];
    const record = (error: unknown): void => {
      errors.push(error);
    };
    process.on("uncaughtException", record);
    try {
      collectGarbage();
      closeConnectionsLeftOpen();
      expect(held.open).toBe(false);
      expect(() => held.close()).not.toThrow();
      expect(() =>
        Database.prototype.prepare.call({ db: handle, open: false }, "SELECT 1"),
      ).toThrow("not open");
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

describe("libSQL's native module", () => {
  it("is the copy @libsql/client loads, found on the first call of a fresh module and kept", async () => {
    vi.resetModules();
    const { libsqlNative } = await import("./close-once.ts");
    const found = libsqlNative();
    expect(found).toBe(Database);
    expect(libsqlNative()).toBe(found);
  });

  // An app at a directory of its own, whose modules `packages` names by path under `node_modules`,
  // each with the source of its `index.js`; resolves the URL of the app's own code.
  const appWith = async (packages: Readonly<Record<string, string>>): Promise<string> => {
    const app = await mkdtemp(join(directory, "app-"));
    for (const [name, source] of Object.entries(packages)) {
      const at = join(app, "node_modules", name);
      await mkdir(at, { recursive: true });
      await writeFile(join(at, "package.json"), JSON.stringify({ name, main: "index.js" }));
      await writeFile(join(at, "index.js"), source);
    }
    return pathToFileURL(join(app, "index.js")).href;
  };

  const copy = (name: string): string => `module.exports = { copy: ${JSON.stringify(name)} };`;

  const CLIENT_BESIDE_APP = {
    "@libsql/client": "module.exports = {};",
    "@libsql/client/node_modules/libsql": copy("the client's"),
    libsql: copy("the app's"),
  };

  const warnings = () => vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

  // From a copy of the module loaded by the test, so what the module sets as it loads, the warning's
  // text and code among it, is part of what the test runs.
  const freshLibsqlNativeFrom = async (): Promise<LibsqlNativeFromFunction> => {
    vi.resetModules();
    return (await import("./close-once.ts")).libsqlNativeFrom;
  };

  it("is the copy beside @libsql/client before one the app's code finds on its own", async () => {
    const warned = warnings();
    try {
      expect((await freshLibsqlNativeFrom())(await appWith(CLIENT_BESIDE_APP))()).toEqual({
        copy: "the client's",
      });
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });

  it("is the copy already loaded when the client and the app's code find different ones", async () => {
    const from = await appWith(CLIENT_BESIDE_APP);
    const loaded: unknown = createRequire(from)("libsql");
    expect((await freshLibsqlNativeFrom())(from)()).toBe(loaded);
    expect(loaded).toEqual({ copy: "the app's" });
  });

  it("is the one the app's code finds on its own, as in a bundle that took @libsql/client in", async () => {
    const warned = warnings();
    try {
      expect(
        (await freshLibsqlNativeFrom())(await appWith({ libsql: copy("the app's") }))(),
      ).toEqual({
        copy: "the app's",
      });
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });

  it("is none, with one warning saying what is lost, when neither finds it", async () => {
    const warned = warnings();
    try {
      const native = (await freshLibsqlNativeFrom())(await appWith({}));
      expect(native()).toBeNull();
      expect(native()).toBeNull();
      expect(warned).toHaveBeenCalledTimes(1);
      const [message, options] = warned.mock.calls[0] ?? [];
      expect(options).toEqual({ code: "BOUNDA_LIBSQL_NATIVE_MISSING" });
      expect(message).toBe(
        "@bounda-dev/sqlite cannot reach libSQL's native module, libsql: it found it neither beside @libsql/client nor on its own. Without it, a libSQL connection closed, collected or left open at exit can be closed twice, which on Windows ends the process with an access violation; and an encrypted file's keys are tried by opening the file under each, so one that does not open it can keep the file from being encrypted until garbage is collected. Leave @libsql/client and libsql out of the bundle, or install libsql at the version @libsql/client depends on.",
      );
    } finally {
      warned.mockRestore();
    }
  });

  it("is none, with a warning naming the error, when the module found does not load", async () => {
    const warned = warnings();
    try {
      const from = await appWith({ libsql: 'throw "no binary for this platform";' });
      expect((await freshLibsqlNativeFrom())(from)()).toBeNull();
      expect(warned).toHaveBeenCalledTimes(1);
      expect(warned.mock.calls[0]?.[0]).toContain(
        `: it could not load it from ${createRequire(from).resolve("libsql")}: no binary for this platform. Without it,`,
      );
    } finally {
      warned.mockRestore();
    }
  });

  it("is none, with a warning, when no module can be looked up from where its code runs", async () => {
    const warned = warnings();
    try {
      expect((await freshLibsqlNativeFrom())("")()).toBeNull();
      expect(warned).toHaveBeenCalledTimes(1);
      let reason = "";
      try {
        createRequire("");
      } catch (error) {
        reason = error instanceof Error ? error.message : "";
      }
      expect(reason).not.toBe("");
      expect(warned.mock.calls[0]?.[0]).toContain(
        `: it cannot look modules up from : ${reason}. Without it,`,
      );
    } finally {
      warned.mockRestore();
    }
  });

  it("is looked up from where the code runs: its own URL, or, in a CommonJS bundle, the script the process runs, or the working directory", () => {
    expect(whereCodeRuns("file:///app/server.js")).toBe("file:///app/server.js");
    const argv = process.argv;
    try {
      process.argv = [argv[0] ?? "node", "/app/bundle.cjs"];
      expect(whereCodeRuns(undefined)).toBe("/app/bundle.cjs");
      process.argv = [argv[0] ?? "node"];
      expect(whereCodeRuns(undefined)).toBe(join(process.cwd(), "index.js"));
    } finally {
      process.argv = argv;
    }
  });
});
