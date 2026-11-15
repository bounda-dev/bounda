import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigurationError,
  createApp,
  type EventPayloadArgs,
  type Registry,
} from "@bounda-dev/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlite } from "./index.ts";

// One personal field, so the app needs keys.
const registry = {
  aggregates: {
    customer: {
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ name: personal(z.string()) }),
          evolve: ({ state }: { state: object }) => state,
        },
      },
      commands: {},
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as unknown as Registry;

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bounda-sqlite-keys-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
    if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
  });
});

describe("the keys of an app on SQLite", () => {
  it("are the database's own in memory, gone with it, so an app there names none", async () => {
    const app = await createApp({ registry, config: { storage: sqlite({ memory: true }) } });
    expect((await app.status()).tenant).toMatchObject({ tenant: "default", forgottenAt: null });
    await app.stop();
  });

  it("must be named for a file, whose data outlives the process", async () => {
    await expect(
      createApp({
        registry,
        config: { storage: sqlite({ path: join(directory, "app.db") }) },
      }),
    ).rejects.toThrow(ConfigurationError);
  });
});
