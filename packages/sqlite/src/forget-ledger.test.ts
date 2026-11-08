import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoundaApp,
  createApp,
  type EventPayloadArgs,
  type PayloadArgs,
  type PersonalDataForgottenPayload,
  type Registry,
} from "@bounda-dev/core";
import type { ForgetLedger } from "@bounda-dev/core/adapter";
import { forgetLedgerContract } from "@bounda-dev/core/adapter/testing";
import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlite } from "./index.ts";

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

let directory: string;
let databases = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bounda-forget-ledger-"));
});

// The ledgers the contract opens are closed before the directory goes, so their files can go.
const opened: ForgetLedger[] = [];

afterAll(async () => {
  await Promise.all(opened.map((ledger) => ledger.close?.()));
  // libSQL lets go of a file that saw a write transaction only once its statements are garbage
  // collected, and Windows cannot delete a file still open: there, those stay behind in the
  // temporary directory.
  await rm(directory, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
    if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
  });
});

const pathOf = (name: string): string => join(directory, `${name}.db`);

const fresh = () => {
  databases += 1;
  return { store: pathOf(`store-${databases}`), ledger: pathOf(`ledger-${databases}`) };
};

describe("the forget ledger in a SQLite file", () => {
  forgetLedgerContract({
    create: async () => {
      const adapter = sqlite({ path: fresh().ledger });
      return async (tenant) => {
        const ledger = await adapter.createForgetLedger({ tenant });
        opened.push(ledger);
        return ledger;
      };
    },
  });
});

interface Paths {
  readonly store: string;
  readonly ledger: string;
}

const boot = (paths: Paths): Promise<BoundaApp> =>
  createApp({
    registry,
    config: {
      storage: sqlite({ path: paths.store }),
      runtime: { personalData: { forgetLedger: { store: sqlite({ path: paths.ledger }) } } },
    },
  });

const register = async (app: BoundaApp, customerId: string): Promise<void> => {
  const commands = app.commands as unknown as Record<
    string,
    (payload: { customerId: string; name: string }) => Promise<unknown>
  >;
  await commands.registerCustomer?.({ customerId, name: `name of ${customerId}` });
};

const forgotten = async (app: BoundaApp): Promise<readonly (readonly [string, string])[]> =>
  (await app.events.read({ limit: 1000 }))
    .filter((event) => event.type === "PersonalDataForgotten")
    .map((event) => {
      const { personId, reason } = event.payload as PersonalDataForgottenPayload;
      return [personId, reason] as const;
    });

const nameOf = async (app: BoundaApp, customerId: string): Promise<unknown> =>
  (await app.exportPersonalData(customerId)).events[0]?.data.name;

// Starts the same app in a process of its own, which exits once the start resolved: two of them
// contend for the file's lock as instances on two machines would. Its registry has the customer
// events the store holds, which the boot checks against the code, and nothing else it needs.
const startElsewhere = (paths: Paths): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createApp } from "@bounda-dev/core";
        import { sqlite } from "./index.ts";
        const app = await createApp({
          registry: {
            aggregates: {
              customer: {
                state: { initialState: {} },
                events: {
                  customerRegistered: {
                    payload: ({ z, personal }) => z.object({ name: personal(z.string()) }),
                    evolve: () => ({}),
                  },
                },
                commands: {},
                policies: {},
                processes: {},
              },
            },
            readModels: {},
          },
          config: {
            storage: sqlite({ path: ${JSON.stringify(paths.store)} }),
            runtime: { personalData: { forgetLedger: { store: sqlite({ path: ${JSON.stringify(paths.ledger)} }) } } },
          },
        });
        await app.stop();`,
      ],
      { cwd: import.meta.dirname, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`the app exited with ${code}`)),
    );
  });

// An online copy, as a backup tool takes it while the app runs.
const backUp = async (from: string, to: string): Promise<void> => {
  const client = createClient({ url: `file:${from}` });
  try {
    await client.execute(`VACUUM INTO '${to}'`);
  } finally {
    client.close();
  }
};

// The copy goes to a file of its own, as a restore beside the lost database would: libSQL holds
// the old file until its statements are garbage collected, and Windows cannot replace it meanwhile.
const restore = async (backup: string): Promise<string> => {
  const to = pathOf(`restored-${databases}`);
  await copyFile(backup, to);
  return to;
};

describe("restoring a backup with a forget ledger", () => {
  it("forgets again whoever was forgotten after the backup was taken, and nobody on a normal start", async () => {
    const paths = fresh();
    const backup = pathOf(`backup-${databases}`);
    const before = await boot(paths);
    await register(before, "c-1");
    await register(before, "c-2");
    await backUp(paths.store, backup);
    await before.forget("c-1");
    await before.runUntilIdle();
    expect(await nameOf(before, "c-1")).toBeNull();
    await before.stop();

    const restoredPaths = { ...paths, store: await restore(backup) };
    const restored = await boot(restoredPaths);
    expect(await forgotten(restored)).toEqual([["c-1", "restored"]]);
    expect(await nameOf(restored, "c-1")).toBeNull();
    expect(await nameOf(restored, "c-2")).toBe("name of c-2");
    await restored.runUntilIdle();
    await restored.stop();

    const again = await boot(restoredPaths);
    expect(await forgotten(again)).toEqual([["c-1", "restored"]]);
    expect(await again.getLag()).toMatchObject({ forgetLedger: { reconciled: true } });
    await again.stop();
  });

  it("forgets a person once when two processes start on the restored copy together", async () => {
    const paths = fresh();
    const backup = pathOf(`backup-${databases}`);
    const before = await boot(paths);
    await register(before, "c-1");
    await backUp(paths.store, backup);
    await before.forget("c-1");
    await before.runUntilIdle();
    await before.stop();

    const restoredPaths = { ...paths, store: await restore(backup) };
    // `VACUUM INTO` writes the copy in rollback-journal mode: two processes switching one file to
    // WAL at once fail with SQLITE_BUSY, as a first start of two instances on a new file would.
    const client = createClient({ url: `file:${restoredPaths.store}` });
    await client.execute("PRAGMA journal_mode = WAL");
    client.close();
    await Promise.all([startElsewhere(restoredPaths), startElsewhere(restoredPaths)]);
    const after = await boot(restoredPaths);
    expect(await forgotten(after)).toEqual([["c-1", "restored"]]);
    await after.stop();
  });

  it("brings the person back without a ledger, which bounda forget --from then forgets again", async () => {
    const store = fresh().store;
    const backup = pathOf(`backup-${databases}`);
    const plain = (path: string) => createApp({ registry, config: { storage: sqlite({ path }) } });
    const before = await plain(store);
    await register(before, "c-1");
    await backUp(store, backup);
    await before.forget("c-1");
    await before.stop();

    const restored = await plain(await restore(backup));
    expect(await nameOf(restored, "c-1")).toBe("name of c-1");
    expect(await restored.forgetAgain([{ personId: "c-1" }])).toEqual(["c-1"]);
    expect(await nameOf(restored, "c-1")).toBeNull();
    await restored.stop();
  });
});
