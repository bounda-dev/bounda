/// <reference types="node" />
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "./node-sqlite.ts";
import { SQLITE_BUSY_TIMEOUT_MS, switchToWal } from "./wal.ts";

const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
const isBusy = (error: unknown): boolean => error === busy;

describe("switchToWal", () => {
  it("switches the file with one statement when nothing holds it", async () => {
    const statements: string[] = [];
    await switchToWal({ execute: async (sql) => statements.push(sql), isBusy });
    expect(statements).toEqual(["PRAGMA journal_mode = WAL"]);
  });

  it("tries again, a short and varying while apart, as long as the file is busy", async () => {
    let attempts = 0;
    const pauses: number[] = [];
    await switchToWal({
      execute: async () => {
        attempts += 1;
        if (attempts < 4) throw busy;
      },
      isBusy,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(attempts).toBe(4);
    expect(pauses).toHaveLength(3);
    for (const ms of pauses) {
      expect(ms).toBeGreaterThanOrEqual(5);
      expect(ms).toBeLessThan(25);
    }
  });

  it("fails at once on any other error", async () => {
    const broken = new Error("disk I/O error");
    let attempts = 0;
    await expect(
      switchToWal({
        execute: async () => {
          attempts += 1;
          throw broken;
        },
        isBusy,
        sleep: async () => undefined,
      }),
    ).rejects.toBe(broken);
    expect(attempts).toBe(1);
  });

  it("gives up with the busy error once the busy timeout has passed", async () => {
    let clock = 1_000;
    let attempts = 0;
    await expect(
      switchToWal({
        execute: async () => {
          attempts += 1;
          throw busy;
        },
        isBusy,
        now: () => clock,
        sleep: async () => {
          clock += SQLITE_BUSY_TIMEOUT_MS / 2;
        },
      }),
    ).rejects.toBe(busy);
    // At the start, half way, and at the deadline itself.
    expect(attempts).toBe(3);
  });
});

const CONNECTIONS = 6;
const ROUNDS = 3;

// Each worker loads the adapter, waits at the gate with the others, then opens its storage: the
// first statements of every connection meet on the file at the same moment.
const WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
import(workerData.module).then(async ({ createNodeSqliteAdapter }) => {
  parentPort.postMessage("loaded");
  Atomics.wait(new Int32Array(workerData.gate), 0, 0);
  try {
    const { adapter, db } = createNodeSqliteAdapter(workerData.path);
    const storage = await adapter.createStorage();
    await storage.close();
    db.close();
    parentPort.postMessage("opened");
  } catch (error) {
    parentPort.postMessage(String(error));
  }
});
`;

const openAtOnce = async (path: string): Promise<readonly string[]> => {
  const gate = new SharedArrayBuffer(4);
  const workers = Array.from(
    { length: CONNECTIONS },
    () =>
      new Worker(WORKER, {
        eval: true,
        workerData: { module: new URL("./node-sqlite.ts", import.meta.url).href, path, gate },
      }),
  );
  const outcomes = workers.map(
    (worker) =>
      new Promise<string>((resolve) => {
        worker.on("message", (message: string) => {
          if (message !== "loaded") resolve(message);
        });
        worker.on("error", (error) => resolve(String(error)));
      }),
  );
  await Promise.all(
    workers.map(
      (worker) =>
        new Promise<void>((resolve) => {
          worker.once("message", () => resolve());
          worker.once("error", () => resolve());
        }),
    ),
  );
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  const results = await Promise.all(outcomes);
  await Promise.all(workers.map((worker) => worker.terminate()));
  return results;
};

describe("the node:sqlite adapter on a file", () => {
  it("opens a file not in WAL yet, such as one just restored, from several connections at once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bounda-wal-"));
    try {
      for (let round = 0; round < ROUNDS; round += 1) {
        const path = join(directory, `restored-${round}.sqlite`);
        const { adapter, db } = createNodeSqliteAdapter(path);
        await (await adapter.createStorage()).close();
        db.exec("PRAGMA journal_mode = DELETE");
        db.close();

        expect(await openAtOnce(path)).toEqual(Array(CONNECTIONS).fill("opened"));
        const check = new DatabaseSync(path);
        expect(check.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
        check.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
