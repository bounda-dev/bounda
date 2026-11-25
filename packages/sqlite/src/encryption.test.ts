import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ConfigurationError, type Logger } from "@bounda-dev/core";
import type { FileKey, FileKeyAccess } from "@bounda-dev/core/adapter";
import { createTestApp, expectForgotten } from "@bounda-dev/core/testing";
import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EncryptionStep,
  encryptInPlace,
  fileEncryptionOf,
  type PrepareFileArgs,
  prepareFile,
} from "./encryption.ts";
import { sqlite } from "./index.ts";
import {
  bootTestApp,
  dayAhead,
  nameOf,
  registerCustomer,
  type TestAppPaths,
  testRegistry,
} from "./test-app.ts";

let directory: string;
let databases = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bounda-encryption-"));
});

afterAll(async () => {
  // libSQL lets go of a file only once its statements are collected, and Windows cannot delete a
  // file still open: there, those stay behind in the temporary directory.
  await rm(directory, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
    if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
  });
});

const fresh = (): TestAppPaths => {
  databases += 1;
  return {
    store: join(directory, `store-${databases}.db`),
    keys: join(directory, `keys-${databases}.db`),
  };
};

// Runs `body` in a process of its own, with `app` started on `paths`: libSQL lets go of a closed
// connection only once it is collected, so only another process starts with the file to itself.
// The app's clock is `shift` milliseconds ahead of the system's, `shift` a variable of `body`.
const elsewhere = (paths: TestAppPaths, body: string, encrypt = true): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { systemClock } from "@bounda-dev/core";
        import { bootTestApp, registerCustomer } from "./test-app.ts";
        let shift = 0;
        const clock = {
          now: () => new Date(Date.now() + shift),
          after: (milliseconds, callback, options) => systemClock.after(milliseconds, callback, options),
        };
        const stateOf = async (started) => (await started.status()).files[0]?.state;
        const app = await bootTestApp(${JSON.stringify(paths)}, { encrypt: ${encrypt}, clock });
        ${body}
        await app.stop();`,
      ],
      { cwd: import.meta.dirname, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`the app exited with ${code}`)),
    );
  });

// A file with one row, under `key`, `null` for none, written by a process of its own, which lets go
// of it as it exits. Each process here that opens the file through the client loads the patch the
// adapter loads: one that exits with a connection open crashes on Windows now and then otherwise.
const fileUnder = (path: string, key: string | null, also = ""): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createClient } from "@libsql/client";
        import { closeConnectionsOnce } from "./close-once.ts";
        closeConnectionsOnce();
        const client = createClient(${JSON.stringify({ url: `file:${path}`, ...(key === null ? {} : { encryptionKey: key }) })});
        await client.execute("PRAGMA journal_mode = WAL");
        await client.execute("CREATE TABLE t (x INTEGER)");
        await client.execute("INSERT INTO t VALUES (1)");
        ${also}`,
      ],
      { cwd: import.meta.dirname, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`the writer exited with ${code}`)),
    );
  });

// A process that holds the file open, as another instance of the app would, until let go, after
// running the statements `writes` on it.
const heldElsewhere = async (path: string, writes = ""): Promise<() => Promise<void>> => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { createClient } from "@libsql/client";
      import { closeConnectionsOnce } from "./close-once.ts";
      closeConnectionsOnce();
      const client = createClient({ url: ${JSON.stringify(`file:${path}`)} });
      await client.execute("SELECT count(*) FROM sqlite_master");
      ${writes}
      console.log("holding");
      setInterval(() => undefined, 1000);`,
    ],
    { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", () => resolve());
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
};

// The row the file holds under `key`.
const rowUnder = async (path: string, key: string): Promise<unknown> => {
  const client = createClient({ url: `file:${path}`, encryptionKey: key });
  try {
    return (await client.execute("SELECT x FROM t")).rows[0]?.x;
  } finally {
    client.close();
  }
};

// Whether the file reads with no key, as any tool that opens it would.
const readsInTheClear = async (path: string): Promise<boolean> => {
  const client = createClient({ url: `file:${path}` });
  try {
    await client.execute("SELECT count(*) FROM sqlite_master");
    return true;
  } catch (error) {
    if (Reflect.get(error as object, "code") === "SQLITE_NOTADB") return false;
    throw error;
  } finally {
    client.close();
  }
};

interface StoredFile {
  readonly database: string;
  readonly appliedAt?: string;
}

// The keys the tenant key store holds for the files of the default tenant.
const filesOf = async (keys: string): Promise<readonly StoredFile[]> => {
  const store = await sqlite({ path: keys }).createTenantKeyStore();
  try {
    const record = await store.get("default");
    return record?.files ?? record?.forgotten?.files ?? [];
  } finally {
    await store.close?.();
  }
};

const warnings = (): {
  readonly logger: Logger;
  readonly lines: string[];
  readonly fields: unknown[];
} => {
  const lines: string[] = [];
  const fields: unknown[] = [];
  const quiet = () => undefined;
  return {
    lines,
    fields,
    logger: {
      debug: quiet,
      info: quiet,
      warn: (message: string, logged?: unknown) => {
        lines.push(message);
        fields.push(logged);
      },
      error: quiet,
    },
  };
};

describe("a libSQL file in an app with a key wrapper and a tenant key store", () => {
  it("is encrypted under a key of the tenant's own, which nothing but the app opens", async () => {
    const paths = fresh();
    const app = await bootTestApp(paths);
    await registerCustomer(app, "c-1");
    await app.stop();
    expect(await readsInTheClear(paths.store)).toBe(false);
    const files = await filesOf(paths.keys);
    expect(files).toEqual([
      expect.objectContaining({ database: paths.store.replaceAll("\\", "/") }),
    ]);
    expect(files[0]?.appliedAt).toEqual(expect.any(String));

    const again = await bootTestApp(paths);
    expect(await nameOf(again, "c-1")).toBe("name of c-1");
    await again.stop();
  });

  it("stays in the clear with encrypt: false", async () => {
    const paths = fresh();
    const app = await bootTestApp(paths, { encrypt: false });
    await registerCustomer(app, "c-1");
    await app.stop();
    expect(await readsInTheClear(paths.store)).toBe(true);
    expect(await filesOf(paths.keys)).toEqual([]);
  });

  it("is encrypted when an app with keys first starts with it to itself, what it holds kept", async () => {
    const paths = fresh();
    await elsewhere(paths, `await registerCustomer(app, "c-1");`, false);
    await elsewhere(paths, "");
    expect(await readsInTheClear(paths.store)).toBe(false);
    expect(existsSync(`${paths.store}.bounda-encrypting`)).toBe(false);
    const app = await bootTestApp(paths);
    expect(await nameOf(app, "c-1")).toBe("name of c-1");
    await app.stop();
  });

  it("opens in the clear while another connection holds it, and says so", async () => {
    const paths = fresh();
    await elsewhere(paths, `await registerCustomer(app, "c-1");`, false);
    const holder = createClient({ url: `file:${paths.store}` });
    await holder.execute("SELECT count(*) FROM sqlite_master");
    const { logger, lines } = warnings();
    const app = await bootTestApp(paths, { logger });
    expect(await nameOf(app, "c-1")).toBe("name of c-1");
    await app.stop();
    holder.close();
    expect(lines).toEqual([expect.stringContaining("left a database file in the clear for now")]);
    expect(await readsInTheClear(paths.store)).toBe(true);
    expect((await filesOf(paths.keys))[0]?.appliedAt).toBeUndefined();
  });

  it("moves under the tenant key's new version at the next start, and drops the earlier key once retired", async () => {
    const paths = fresh();
    const copy = join(directory, `copy-${databases}.db`);
    // Another instance holds the file: it stays under its earlier key until the next start.
    await elsewhere(
      paths,
      `const other = await bootTestApp(${JSON.stringify(paths)});
      await registerCustomer(app, "c-1");
      await app.rotateTenantKey();
      await app.runUntilIdle();
      if ((await stateOf(app)) !== "earlier") throw new Error("not under the earlier key");
      await other.stop();`,
    );
    expect((await filesOf(paths.keys)).map(({ appliedAt }) => appliedAt !== undefined)).toEqual([
      false,
      true,
    ]);
    await copyFile(paths.store, copy);

    await elsewhere(paths, "");
    expect((await filesOf(paths.keys)).map(({ appliedAt }) => appliedAt !== undefined)).toEqual([
      true,
      true,
    ]);
    const app = await bootTestApp(paths, { clock: dayAhead });
    expect(await nameOf(app, "c-1")).toBe("name of c-1");
    await app.runUntilIdle();
    await app.retireTenantKeys();
    await app.stop();
    expect(await filesOf(paths.keys)).toHaveLength(1);

    // A copy taken under the retired key opens under none left.
    await expect(bootTestApp({ store: copy, keys: paths.keys })).rejects.toThrow(
      "opens under none of its tenant's keys",
    );
  });

  it("keeps a file's earlier key, through a retire, while another instance holds the file", async () => {
    const paths = fresh();
    await elsewhere(
      paths,
      `const other = await bootTestApp(${JSON.stringify(paths)});
      await registerCustomer(app, "c-1");
      await app.rotateTenantKey();
      await app.runUntilIdle();
      if ((await stateOf(app)) !== "earlier") throw new Error("not under the earlier key");
      shift = 86_400_000;
      await app.retireTenantKeys();
      await other.stop();`,
    );
    expect(await filesOf(paths.keys)).toHaveLength(2);
    await elsewhere(paths, "");
    const app = await bootTestApp(paths);
    expect(await nameOf(app, "c-1")).toBe("name of c-1");
    await app.stop();
  });

  it("moves the file under the new key in the app that rotated, once alone, so a retire drops the earlier", async () => {
    const paths = fresh();
    await elsewhere(
      paths,
      `await registerCustomer(app, "c-1");
      await app.rotateTenantKey();
      if ((await stateOf(app)) !== "earlier") throw new Error("not under the earlier key");
      await app.runUntilIdle();
      if ((await stateOf(app)) !== "current") throw new Error("not moved");
      shift = 86_400_000;
      await app.retireTenantKeys();`,
    );
    expect(await filesOf(paths.keys)).toEqual([
      expect.objectContaining({ appliedAt: expect.any(String) }),
    ]);
    const app = await bootTestApp(paths);
    expect(await nameOf(app, "c-1")).toBe("name of c-1");
    await app.stop();
  });

  it("is forgotten with its tenant: once the recipients are told, the file and its copies open no more", async () => {
    const paths = fresh();
    const copy = join(directory, `copy-${databases}.db`);
    const app = await bootTestApp(paths);
    await registerCustomer(app, "c-1");
    await app.stop();
    await copyFile(paths.store, copy);
    const forgetting = await bootTestApp(paths);
    await forgetting.forgetTenant("default");
    expect(await filesOf(paths.keys)).toHaveLength(1);
    await forgetting.runUntilIdle();
    expect(await filesOf(paths.keys)).toEqual([]);
    await forgetting.stop();

    for (const store of [paths.store, copy]) {
      const restarted = await bootTestApp({ store, keys: paths.keys });
      expect((await restarted.status()).tenant).toMatchObject({ forgottenAt: expect.any(String) });
      await restarted.stop();
    }
  });
});

// Where a database says whose it is, as the adapter names it.
// What the file opens under, and the encryption it still awaits, its connection closed: the
// adapter would keep it.
const prepare = async (args: Omit<PrepareFileArgs, "tenancy">) => {
  const prepared = await prepareFile({ ...args, tenancy: '"bounda_tenancy"' });
  if ("gone" in prepared) return prepared;
  const { client, under, inForce } = prepared;
  client.close();
  return {
    key: under?.key ?? null,
    pending: under?.id === inForce.id ? null : { from: under, to: inForce },
  };
};

// The keys of one file, as the tenant key store hands them out.
const keysOf = (first: FileKey | null, previous: readonly FileKey[] = [], tenant = "default") => {
  let current = first;
  const confirmed: string[] = [];
  const keys: FileKeyAccess = {
    tenant,
    current: async () => current,
    previous: async () => previous,
    confirm: async (id) => {
      confirmed.push(id);
    },
  };
  return {
    keys,
    confirmed: () => confirmed.length,
    confirmedIds: () => confirmed,
    rotate: (next: FileKey) => {
      current = next;
    },
  };
};

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const A = { id: "f-a", key: "a".repeat(64) };
const B = { id: "f-b", key: "b".repeat(64) };

describe("prepareFile", () => {
  it("encrypts in place a file in the clear, and one under an earlier key, keeping what it holds", async () => {
    const plain = fresh().store;
    await fileUnder(plain, null);
    const fromPlain = keysOf(A);
    expect(await prepare({ path: plain, keys: fromPlain.keys, logger: silent })).toMatchObject({
      key: A.key,
    });
    expect(fromPlain.confirmed()).toBe(1);
    expect(existsSync(`${plain}.bounda-encrypting`)).toBe(false);
    expect(await rowUnder(plain, A.key)).toBe(1);

    const earlier = fresh().store;
    await fileUnder(earlier, A.key);
    const rotated = keysOf(B, [A]);
    expect(await prepare({ path: earlier, keys: rotated.keys, logger: silent })).toMatchObject({
      key: B.key,
    });
    expect(rotated.confirmed()).toBe(1);
    expect(await rowUnder(earlier, B.key)).toBe(1);
  });

  it("opens a file under an earlier key as it is while another connection holds it, and says so", async () => {
    const path = fresh().store;
    await fileUnder(path, A.key);
    const holder = createClient({ url: `file:${path}`, encryptionKey: A.key });
    await holder.execute("SELECT count(*) FROM t");
    const { logger, lines, fields } = warnings();
    const rotated = keysOf(B, [A]);
    expect(await prepare({ path, keys: rotated.keys, logger })).toMatchObject({ key: A.key });
    holder.close();
    expect(rotated.confirmed()).toBe(0);
    expect(fields).toEqual([{ file: path }]);
    expect(lines).toEqual([
      expect.stringContaining("left a database file under its tenant's earlier key for now"),
    ]);
  });

  it("leaves in the clear a file another tenant's database is bound to", async () => {
    const paths = fresh();
    await elsewhere(paths, `await registerCustomer(app, "c-1");`, false);
    await expect(
      prepare({ path: paths.store, keys: keysOf(A, [], "acme").keys, logger: silent }),
    ).rejects.toThrow(
      new ConfigurationError(
        "This database belongs to tenant default, and the app serves acme: give it its own database",
      ),
    );
    expect(existsSync(`${paths.store}.bounda-encrypting`)).toBe(false);
    expect(await readsInTheClear(paths.store)).toBe(true);
  });

  it("encrypts a file in the clear that names no tenant yet", async () => {
    const path = fresh().store;
    await fileUnder(
      path,
      null,
      `await client.execute("CREATE TABLE bounda_tenancy (tenant TEXT)");`,
    );
    await expect(
      prepare({ path, keys: keysOf(A, [], "acme").keys, logger: silent }),
    ).resolves.toMatchObject({ key: A.key, pending: null });
  });

  it("opens first under the earlier key a cut-short encryption names", async () => {
    const path = fresh().store;
    await fileUnder(path, A.key);
    await writeFile(`${path}.bounda-encrypting`, JSON.stringify({ from: A.id }));
    const rotated = keysOf(B, [{ id: "f-0", key: "0".repeat(64) }, A]);
    expect(await prepare({ path, keys: rotated.keys, logger: silent })).toMatchObject({
      key: B.key,
    });
    expect(existsSync(`${path}.bounda-encrypting`)).toBe(false);
    expect(await rowUnder(path, B.key)).toBe(1);
  });

  it("fails on a file that does not read for another reason than its key", async () => {
    const path = fresh().store;
    await fileUnder(path, A.key);
    const holder = createClient({ url: `file:${path}`, encryptionKey: A.key });
    await holder.execute("PRAGMA locking_mode = EXCLUSIVE");
    await holder.execute("BEGIN EXCLUSIVE");
    try {
      await expect(prepare({ path, keys: keysOf(A).keys, logger: silent })).rejects.toMatchObject({
        code: "SQLITE_BUSY",
      });
    } finally {
      holder.close();
    }
  });

  it("opens a new file under the key in force, and none once the keys are gone", async () => {
    const path = `${fresh().store}.new`;
    const { keys, confirmed } = keysOf({ id: "f-1", key: "aa" });
    expect(await prepare({ path, keys, logger: silent })).toMatchObject({ key: "aa" });
    expect(confirmed()).toBe(1);
    expect(existsSync(path)).toBe(true);
    expect(await prepare({ path, keys: keysOf(null).keys, logger: silent })).toEqual({
      gone: true,
    });
  });

  it("opens first under the key a cut-short encryption started from, and finishes it", async () => {
    const paths = fresh();
    await elsewhere(paths, `await registerCustomer(app, "c-1");`, false);
    await writeFile(`${paths.store}.bounda-encrypting`, JSON.stringify({ from: null }));
    const { keys, confirmed } = keysOf({ id: "f-2", key: "bb" }, [{ id: "f-1", key: "aa" }]);
    expect(await prepare({ path: paths.store, keys, logger: silent })).toMatchObject({ key: "bb" });
    expect(confirmed()).toBe(1);
    expect(existsSync(`${paths.store}.bounda-encrypting`)).toBe(false);
    expect(await readsInTheClear(paths.store)).toBe(false);
  });

  it("refuses a file a cut-short encryption started from a key the record no longer holds", async () => {
    const paths = fresh();
    await elsewhere(paths, `await registerCustomer(app, "c-1");`, false);
    await writeFile(`${paths.store}.bounda-encrypting`, JSON.stringify({ from: "f-0" }));
    await expect(
      prepare({
        path: paths.store,
        keys: keysOf({ id: "f-1", key: "aa" }).keys,
        logger: silent,
      }),
    ).rejects.toThrow(
      new ConfigurationError(
        `The database file ${paths.store} was being encrypted from a key its tenant's record no longer holds: restore the file from a copy`,
      ),
    );
  });
});

// A connection that answers each statement as `answer` says, recording them.
const fakeSource = (answer: (sql: string) => unknown) => {
  const statements: string[] = [];
  const source = {
    execute: async (sql: string) => {
      statements.push(sql);
      // The busy timeout it sets and puts back answers like any setting.
      const answered = sql.startsWith("PRAGMA busy_timeout") ? { rows: [] } : answer(sql);
      if (answered instanceof Error) throw answered;
      return answered;
    },
  } as unknown as Parameters<typeof encryptInPlace>[1];
  return { source, statements };
};

const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

describe("encryptInPlace", () => {
  it("leaves the file as it is while another connection holds it, whatever the engine answers", async () => {
    const path = fresh().store;
    for (const answer of [{ rows: [] }, { rows: [["wal"]] }, busy]) {
      const { source, statements } = fakeSource(() => answer);
      expect(await encryptInPlace(path, source, null, A)).toBe(false);
      expect(statements).toEqual([
        "PRAGMA busy_timeout = 0",
        "PRAGMA journal_mode = DELETE",
        "PRAGMA busy_timeout = 5000",
      ]);
    }
    expect(existsSync(`${path}.bounda-encrypting`)).toBe(false);
  });

  it("fails on anything else the engine throws", async () => {
    const failure = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    const { source } = fakeSource(() => failure);
    await expect(encryptInPlace(fresh().store, source, null, A)).rejects.toThrow(failure);
  });

  it("names the key it encrypts from until the rekey is done, quoting the key it encrypts under", async () => {
    for (const from of [A, null]) {
      const path = fresh().store;
      const failure = new Error("cut short");
      const { source, statements } = fakeSource((sql) =>
        sql.startsWith("PRAGMA rekey") ? failure : { rows: [["delete"]] },
      );
      await expect(encryptInPlace(path, source, from, { id: "f-q", key: "it's" })).rejects.toThrow(
        failure,
      );
      expect(statements.at(-2)).toBe("PRAGMA rekey = 'it''s'");
      expect(JSON.parse(await readFile(`${path}.bounda-encrypting`, "utf8"))).toEqual({
        from: from?.id ?? null,
      });
    }
  });
});

describe("a libSQL file left in the clear while another process held it", () => {
  it("says so, refuses to forget its tenant, and is encrypted by the app once let go", async () => {
    const paths = fresh();
    await elsewhere(paths, `await registerCustomer(app, "c-1");`, false);
    const letGo = await heldElsewhere(paths.store);
    const file = paths.store.replaceAll("\\", "/");
    // What the app logs once the file is let go names the branch a file still in the clear took: an
    // error, a warning that it was still held, or no word of the file, no pass having tried.
    const logged: { level: string; message: string; fields: unknown }[] = [];
    let recording = false;
    const record =
      (level: string, ofTheFileOnly = false) =>
      (message: string, fields?: Record<string, unknown>): void => {
        if (recording && (!ofTheFileOnly || fields?.file === file)) {
          logged.push({ level, message, fields });
        }
      };
    const app = await bootTestApp(paths, {
      logger: {
        debug: () => undefined,
        info: record("info", true),
        warn: record("warn"),
        error: record("error"),
      },
    });
    try {
      expect((await app.status()).files).toEqual([{ database: "storage", file, state: "clear" }]);
      await expect(app.forgetTenant("default")).rejects.toThrow(
        "is still in the clear, so forgetting the tenant would leave it readable",
      );
      expect((await app.status()).tenant).toMatchObject({ forgottenAt: null });
      await letGo();
      recording = true;
      await app.runUntilIdle();
      recording = false;
      expect(
        { files: (await app.status()).files, logged },
        `the descriptors this process has open on the file: ${await openHere(paths.store)}`,
      ).toEqual({
        files: [{ database: "storage", file, state: "current" }],
        logged: [
          {
            level: "info",
            message: "bounda encrypted a database file under its tenant's key in force",
            fields: { file },
          },
        ],
      });
      expect(await nameOf(app, "c-1")).toBe("name of c-1");
      await app.forgetTenant("default");
    } finally {
      await letGo();
      await app.stop();
    }
    expect(await readsInTheClear(paths.store)).toBe(false);
  });
});

// An app started on `paths` in a process of its own whose young generation outgrows what the app
// allocates, so nothing it lets go of is collected while it runs: what it holds on the file is
// what it never closed. Once `booted`, `proceed` has it run until idle and resolves to where its
// file stands; `stop` ends it, whatever it was doing.
const bootedElsewhere = (paths: TestAppPaths) => {
  const child = spawn(
    process.execPath,
    [
      "--max-semi-space-size=512",
      "--min-semi-space-size=512",
      "--input-type=module",
      "-e",
      `import { createInterface } from "node:readline";
      import { bootTestApp } from "./test-app.ts";
      const app = await bootTestApp(${JSON.stringify(paths)});
      console.log("booted");
      for await (const _ of createInterface({ input: process.stdin })) break;
      await app.runUntilIdle();
      console.log((await app.status()).files[0]?.state);
      await app.stop();`,
    ],
    { cwd: import.meta.dirname, stdio: ["pipe", "pipe", "inherit"] },
  );
  const said = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async (): Promise<string | undefined> => {
    const { done, value } = await said.next();
    return done === true ? undefined : value;
  };
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return {
    booted: next(),
    proceed: async () => {
      child.stdin.end("go\n");
      return { state: await next(), code: await exited };
    },
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
};

// The descriptors this process has open on the database at `path` and its WAL, where the system
// lists them: one connection holds one of each.
const openHere = async (path: string): Promise<string> => {
  if (process.platform !== "linux") return "not listed here";
  const targets = await Promise.all(
    (await readdir("/proc/self/fd")).map((fd) => readlink(`/proc/self/fd/${fd}`).catch(() => null)),
  );
  return JSON.stringify(targets.filter((target) => target?.startsWith(path) === true));
};

describe("a libSQL file in the clear held by another process that wrote to it", () => {
  it("is encrypted once let go, though no garbage was collected since the app tried its keys on it", async () => {
    const paths = fresh();
    await elsewhere(paths, `await registerCustomer(app, "c-1");`, false);
    // What the other process writes stays in the WAL, page 1 included, until it lets go.
    const letGo = await heldElsewhere(
      paths.store,
      `await client.execute("PRAGMA wal_autocheckpoint = 0");
      await client.execute("PRAGMA user_version = 1");`,
    );
    const app = bootedElsewhere(paths);
    try {
      try {
        expect(await app.booted).toBe("booted");
      } finally {
        await letGo();
      }
      expect(await app.proceed()).toEqual({ state: "current", code: 0 });
    } finally {
      await app.stop();
    }
    expect(await readsInTheClear(paths.store)).toBe(false);
  });
});

describe("a test app over a libSQL file", () => {
  it("encrypts it under the test's keys, and searches it through them once a person is forgotten", async () => {
    const path = fresh().store;
    const { app } = await createTestApp({ registry: testRegistry, adapter: sqlite({ path }) });
    await registerCustomer(app, "c-1");
    await app.forget("c-1");
    await expectForgotten(app, "c-1", { values: ["name of c-1"] });
    await app.stop();
    expect(await readsInTheClear(path)).toBe(false);
  });
});

// A file of `rows` rows of 4 KB under `key`, big enough for a rekey to take a while.
const bigFileUnder = (path: string, key: string, rows: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createClient } from "@libsql/client";
        import { closeConnectionsOnce } from "./close-once.ts";
        closeConnectionsOnce();
        const client = createClient(${JSON.stringify({ url: `file:${path}`, encryptionKey: key })});
        await client.execute("PRAGMA journal_mode = WAL");
        await client.execute("CREATE TABLE t (x INTEGER, pad BLOB)");
        const transaction = await client.transaction("write");
        for (let row = 0; row < ${rows}; row += 1) {
          await transaction.execute("INSERT INTO t VALUES (1, zeroblob(4000))");
        }
        await transaction.commit();`,
      ],
      { cwd: import.meta.dirname, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`the writer exited with ${code}`)),
    );
  });

// Encrypts the file from A to B in a process of its own, which dies at `at`: after that step, or,
// for "rekeying", killed once the rekey's journal holds a third of the file, so pages under the
// new key, the first one among them, are on disk beside the journal of the old: the state in which
// opening under the new key first would play the journal back unreadable. The process says
// synchronously that the mark is written, since the rekey blocks it until done.
const encryptionCutShort = (path: string, at: EncryptionStep | "rekeying"): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { writeSync } from "node:fs";
        import { createClient } from "@libsql/client";
        import { closeConnectionsOnce } from "./close-once.ts";
        import { encryptInPlace } from "./encryption.ts";
        closeConnectionsOnce();
        const source = createClient(${JSON.stringify({ url: `file:${path}`, encryptionKey: A.key })});
        await source.execute("SELECT count(*) FROM sqlite_master");
        await encryptInPlace(${JSON.stringify(path)}, source, ${JSON.stringify(A)}, ${JSON.stringify(B)}, (step) => {
          if (step === ${JSON.stringify(at)}) process.exit(0);
          if (step === "marked") writeSync(1, "marked\\n");
        });`,
      ],
      { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "inherit"] },
    );
    let watching: NodeJS.Timeout | undefined;
    child.stdout.once("data", () => {
      if (at !== "rekeying") return;
      const third = statSync(path).size / 3;
      watching = setInterval(() => {
        if (existsSync(`${path}-journal`) && statSync(`${path}-journal`).size > third) {
          child.kill("SIGKILL");
        }
      }, 1);
    });
    child.once("error", reject);
    child.once("exit", () => {
      clearInterval(watching);
      resolve();
    });
  });

// How many rows the file holds under `key`.
const rowsUnder = async (path: string, key: string): Promise<unknown> => {
  const client = createClient({ url: `file:${path}`, encryptionKey: key });
  try {
    return (await client.execute("SELECT count(*) AS n FROM t")).rows[0]?.n;
  } finally {
    client.close();
  }
};

describe("an encryption cut short", () => {
  const ROWS = 12_000;
  let original: string;

  beforeAll(async () => {
    original = fresh().store;
    await bigFileUnder(original, A.key, ROWS);
  }, 120_000);

  it.each<EncryptionStep | "rekeying">(["unshared", "marked", "rekeying", "rekeyed"])(
    "finishes at the next start, every row kept, when cut short at %s",
    async (at) => {
      const path = fresh().store;
      await copyFile(original, path);
      await encryptionCutShort(path, at);
      // The cut leaves a journal of the pages as they were, under A, halfway through the rekey.
      if (at === "rekeying") expect(existsSync(`${path}-journal`)).toBe(true);
      if (at === "marked" || at === "rekeying" || at === "rekeyed") {
        expect(existsSync(`${path}.bounda-encrypting`)).toBe(true);
      }
      // A key of the tenant's that never encrypted this file comes first: only the mark says which.
      const rotated = keysOf(B, [{ id: "f-0", key: "0".repeat(64) }, A]);
      expect(await prepare({ path, keys: rotated.keys, logger: silent })).toMatchObject({
        key: B.key,
        pending: null,
      });
      expect(rotated.confirmed()).toBe(1);
      expect(existsSync(`${path}.bounda-encrypting`)).toBe(false);
      expect(existsSync(`${path}-journal`)).toBe(false);
      expect(await rowsUnder(path, B.key)).toBe(ROWS);
    },
    120_000,
  );
});

describe("fileEncryptionOf", () => {
  it("says where the file stands, and moves it under the key in force once it can, once", async () => {
    let free = false;
    const told: string[] = [];
    const { keys, confirmed } = keysOf(B, [A]);
    const settled = fresh().store;
    const encryption = fileEncryptionOf({
      path: settled,
      database: "data/acme.db",
      keys,
      under: A,
      inForce: B,
      alone: async (task) => task(fakeSource(() => (free ? { rows: [["delete"]] } : busy)).source),
      encrypted: (key) => {
        told.push(key);
      },
    });
    expect(encryption.database).toBe("data/acme.db");
    expect(encryption.state()).toBe("earlier");
    expect(await encryption.settle()).toBe("earlier");
    expect(told).toEqual([]);
    free = true;
    expect(await encryption.settle()).toBe("current");
    expect(await encryption.settle()).toBe("current");
    expect(told).toEqual([B.key]);
    expect(confirmed()).toBe(1);
    expect(existsSync(`${settled}.bounda-encrypting`)).toBe(false);
    const clear = fileEncryptionOf({
      path: fresh().store,
      database: "data/clear.db",
      keys,
      under: null,
      inForce: B,
      alone: async (task) => task(fakeSource(() => busy).source),
      encrypted: () => undefined,
    });
    expect(clear.state()).toBe("clear");
    const current = fileEncryptionOf({
      path: fresh().store,
      database: "data/current.db",
      keys,
      under: B,
      inForce: B,
      alone: async () => {
        throw new Error("nothing to encrypt");
      },
      encrypted: () => undefined,
    });
    expect(await current.settle()).toBe("current");
  });

  it("reads the key in force again, and moves the file under a key rotated in since", async () => {
    const { keys, confirmedIds, rotate } = keysOf(A);
    const C = { id: "f-c", key: "c".repeat(64) };
    const encryption = fileEncryptionOf({
      path: fresh().store,
      database: "data/acme.db",
      keys,
      under: A,
      inForce: A,
      alone: async (task) => task(fakeSource(() => ({ rows: [["delete"]] })).source),
      encrypted: () => undefined,
    });
    expect(await encryption.refresh()).toBe("current");
    rotate(C);
    expect(encryption.state()).toBe("current");
    expect(await encryption.refresh()).toBe("earlier");
    expect(await encryption.settle()).toBe("current");
    expect(confirmedIds()).toEqual([C.id]);
    const gone = keysOf(null);
    const forgotten = fileEncryptionOf({
      path: fresh().store,
      database: "data/gone.db",
      keys: gone.keys,
      under: A,
      inForce: A,
      alone: async () => {
        throw new Error("nothing to encrypt");
      },
      encrypted: () => undefined,
    });
    expect(await forgotten.refresh()).toBe("current");
  });
});
