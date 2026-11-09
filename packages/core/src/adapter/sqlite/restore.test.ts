import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BoundaApp, createApp } from "../../kernel/app.ts";
import { createRecordingLogger } from "../../kernel/test-support.ts";
import type { EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { Adapter } from "../adapter.ts";
import { restoreContract } from "../testing/restore.contract.ts";
import { createNodeSqliteAdapter } from "./node-sqlite.ts";

let directory: string;
let files = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bounda-restore-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const fresh = (name: string): string => {
  files += 1;
  return join(directory, `${name}-${files}.db`);
};

describe("restoring a node:sqlite database", () => {
  restoreContract({
    hot: true,
    create: async () => {
      const path = fresh("store");
      const copy = fresh("backup");
      const { adapter, db } = createNodeSqliteAdapter(path);
      return {
        storage: adapter,
        forgetLedger: createNodeSqliteAdapter(fresh("ledger")).adapter,
        // An online copy, as a backup tool takes it while the app runs.
        backUp: async () => {
          db.exec(`VACUUM INTO '${copy}'`);
        },
        // In place, through SQLite's backup API, as the sqlite3 shell's .restore does: the app's
        // connection sees the copy at its next statement.
        restore: async () => {
          const source = new DatabaseSync(copy, { readOnly: true });
          try {
            await backup(source, path);
          } finally {
            source.close();
          }
          return adapter;
        },
      };
    },
  });
});

const registry = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ name: personal(z.string()) }),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string(), name: z.string() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { name: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerRegistered?.({ name: command.payload.name })],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as unknown as Registry;

const register = (app: BoundaApp, customerId: string): Promise<unknown> =>
  (
    app.commands as unknown as Record<string, (payload: unknown) => Promise<unknown>>
  ).registerCustomer?.({ customerId, name: `name of ${customerId}` }) ?? Promise.resolve();

const nameOf = async (app: BoundaApp, customerId: string): Promise<unknown> =>
  (await app.exportPersonalData(customerId)).events[0]?.data.name;

// A database, its copy taken after c-1 registered, and c-1 forgotten since.
const forgottenSinceTheCopy = async (forgetLedger?: Adapter) => {
  const path = fresh("store");
  const copy = fresh("backup");
  const { adapter, db } = createNodeSqliteAdapter(path);
  const config = {
    storage: adapter,
    ...(forgetLedger === undefined
      ? {}
      : { runtime: { personalData: { forgetLedger: { store: forgetLedger } } } }),
  };
  const before = await createApp({ registry, config });
  await register(before, "c-1");
  db.exec(`VACUUM INTO '${copy}'`);
  await before.forget("c-1");
  await before.stop();
  const restore = async (): Promise<void> => {
    const source = new DatabaseSync(copy, { readOnly: true });
    try {
      await backup(source, path);
    } finally {
      source.close();
    }
  };
  return { config, restore };
};

describe("a restore under a running app", () => {
  it("is noticed even before the app's first pass", async () => {
    const { config, restore } = await forgottenSinceTheCopy(
      createNodeSqliteAdapter(fresh("ledger")).adapter,
    );
    const app = await createApp({ registry, config });
    await restore();
    await app.runUntilIdle();
    expect(await nameOf(app, "c-1")).toBeNull();
    await app.stop();
  });

  it("is noticed right after a forgetting, before any pass has read it", async () => {
    const path = fresh("store");
    const copy = fresh("backup");
    const { adapter, db } = createNodeSqliteAdapter(path);
    const app = await createApp({
      registry,
      config: {
        storage: adapter,
        runtime: {
          personalData: {
            forgetLedger: { store: createNodeSqliteAdapter(fresh("ledger")).adapter },
          },
        },
      },
    });
    await register(app, "c-1");
    await app.runUntilIdle();
    db.exec(`VACUUM INTO '${copy}'`);
    await app.forget("c-1");
    const source = new DatabaseSync(copy, { readOnly: true });
    try {
      await backup(source, path);
    } finally {
      source.close();
    }
    expect(await nameOf(app, "c-1")).toBe("name of c-1");
    await app.runUntilIdle();
    expect(await nameOf(app, "c-1")).toBeNull();
    await app.stop();
  });

  it("without a forget ledger, is logged as bringing persons back", async () => {
    const { config, restore } = await forgottenSinceTheCopy();
    const { logger, entries } = createRecordingLogger();
    const app = await createApp({ registry, config, logger });
    await restore();
    await app.runUntilIdle();
    expect(await nameOf(app, "c-1")).toBe("name of c-1");
    expect(entries).toContainEqual({
      level: "error",
      message:
        "without runtime.personalData.forgetLedger, whoever was forgotten after the copy was taken is back until forgotten again, as bounda forget --from does",
    });
    expect(
      entries.filter(({ message }) => message.startsWith("without runtime.personalData")),
    ).toHaveLength(1);
    await app.stop();
  });
});
