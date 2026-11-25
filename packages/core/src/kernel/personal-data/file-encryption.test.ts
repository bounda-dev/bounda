import { describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import type { FileEncryptionState } from "../../adapter/storage/encrypted-file.ts";
import { resolveConfig } from "../../config/schema.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import { createRecordingLogger } from "../test-support.ts";
import { createFileEncryptions, FILE_ENCRYPTION_RETRY_MS } from "./file-encryption.ts";

// An adapter over a file in `state`, which a settle moves to "current" once `free` says so.
const fileIn = (database: string, initial: FileEncryptionState) => {
  let state = initial;
  let free = false;
  let settles = 0;
  let refreshes = 0;
  const adapter: Adapter = {
    ...memory(),
    fileEncryption: {
      database,
      state: () => state,
      refresh: async () => {
        refreshes += 1;
        return state;
      },
      settle: async () => {
        settles += 1;
        if (free) state = "current";
        return state;
      },
    },
  };
  return {
    adapter,
    letGo: () => {
      free = true;
    },
    settles: () => settles,
    refreshes: () => refreshes,
  };
};

describe("createFileEncryptions", () => {
  it("names every file, by the database it holds, and where it stands", () => {
    const storage = fileIn("data/acme.db", "current");
    const rows = fileIn("data/rows.db", "earlier");
    const files = createFileEncryptions({
      config: resolveConfig({
        storage: storage.adapter,
        readModels: { rows: rows.adapter, plain: memory() },
      }),
      clock: createFixedClock(),
      logger: createRecordingLogger().logger,
    });
    expect(files.status()).toEqual([
      { database: "storage", file: "data/acme.db", state: "current" },
      { database: "readModels.rows", file: "data/rows.db", state: "earlier" },
    ]);
  });

  it("tries again on what is not under the key in force, at most once every FILE_ENCRYPTION_RETRY_MS", async () => {
    const storage = fileIn("data/acme.db", "clear");
    const clock = createFixedClock();
    const recording = createRecordingLogger();
    const files = createFileEncryptions({
      config: resolveConfig({ storage: storage.adapter }),
      clock,
      logger: recording.logger,
    });
    await files.settle();
    await files.settle();
    expect(storage.settles()).toBe(1);
    expect(recording.entries).toEqual([
      {
        level: "warn",
        message:
          "bounda left a database file as it is for now: another connection has it open, so the worker tries again later",
        fields: { file: "data/acme.db", state: "clear" },
      },
    ]);
    recording.entries.length = 0;
    clock.advance(FILE_ENCRYPTION_RETRY_MS - 1);
    await files.settle();
    expect(storage.settles()).toBe(1);
    storage.letGo();
    clock.advance(1);
    await files.settle();
    expect(storage.settles()).toBe(2);
    expect(files.status()).toMatchObject([{ state: "current" }]);
    expect(recording.entries).toEqual([
      {
        level: "info",
        message: "bounda encrypted a database file under its tenant's key in force",
        fields: { file: "data/acme.db" },
      },
    ]);
    clock.advance(FILE_ENCRYPTION_RETRY_MS);
    await files.settle();
    expect(storage.settles()).toBe(2);
  });

  it("logs what fails, and goes on", async () => {
    const failing: Adapter = {
      ...memory(),
      fileEncryption: {
        database: "data/broken.db",
        state: () => "clear",
        refresh: async () => {
          throw new Error("the store is down");
        },
        settle: async () => {
          throw new Error("disk I/O error");
        },
      },
    };
    const recording = createRecordingLogger();
    const files = createFileEncryptions({
      config: resolveConfig({ storage: failing }),
      clock: createFixedClock(),
      logger: recording.logger,
    });
    await files.settle();
    expect(recording.entries).toMatchObject([
      {
        level: "error",
        message: "bounda could not read the key of a database file",
        fields: { file: "data/broken.db" },
      },
      {
        level: "error",
        message: "bounda could not encrypt a database file under its tenant's key",
        fields: { file: "data/broken.db" },
      },
    ]);
    await expect(files.refuseClear()).rejects.toThrow("disk I/O error");
  });

  it("reads every key again on each try, and at once after a rotation here", async () => {
    const storage = fileIn("data/acme.db", "current");
    const clock = createFixedClock();
    const files = createFileEncryptions({
      config: resolveConfig({ storage: storage.adapter }),
      clock,
      logger: createRecordingLogger().logger,
    });
    await files.settle();
    await files.settle();
    expect(storage.refreshes()).toBe(1);
    expect(storage.settles()).toBe(0);
    await files.refresh();
    expect(storage.refreshes()).toBe(2);
    await files.settle();
    expect(storage.refreshes()).toBe(3);
  });

  it("tries again at once on a clock set back", async () => {
    const storage = fileIn("data/acme.db", "earlier");
    const clock = createFixedClock(new Date("2026-01-01T00:10:00.000Z"));
    const files = createFileEncryptions({
      config: resolveConfig({ storage: storage.adapter }),
      clock,
      logger: createRecordingLogger().logger,
    });
    await files.settle();
    clock.set(new Date("2026-01-01T00:00:00.000Z"));
    await files.settle();
    expect(storage.settles()).toBe(2);
  });

  it("refuses to leave a file in the clear, encrypting it first when it can", async () => {
    const clear = fileIn("data/acme.db", "clear");
    const earlier = fileIn("data/rows.db", "earlier");
    const files = createFileEncryptions({
      config: resolveConfig({ storage: clear.adapter, readModels: { rows: earlier.adapter } }),
      clock: createFixedClock(),
      logger: createRecordingLogger().logger,
    });
    await expect(files.refuseClear()).rejects.toThrow(
      new ConfigurationError(
        "The database file data/acme.db is still in the clear, so forgetting the tenant would leave it readable: stop every other connection to it, run bounda rekey, then forget the tenant again",
      ),
    );
    clear.letGo();
    await files.refuseClear();
    expect(earlier.settles()).toBe(0);
  });
});
