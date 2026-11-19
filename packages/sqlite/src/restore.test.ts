import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreContract } from "@bounda-dev/core/adapter/testing";
import { type Client, createClient } from "@libsql/client";
import { afterAll, beforeAll, describe } from "vitest";
import { sqlite } from "./index.ts";

let directory: string;
let files = 0;
const clients: Client[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bounda-restore-"));
});

afterAll(async () => {
  for (const client of clients) client.close();
  // libSQL lets go of a file that saw a write transaction only once its statements are garbage
  // collected, and Windows cannot delete a file still open: there, those stay behind in the
  // temporary directory.
  await rm(directory, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
    if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
  });
});

const fresh = (name: string): string => {
  files += 1;
  return join(directory, `${name}-${files}.db`);
};

const clientOf = (path: string): Client => {
  const client = createClient({ url: `file:${path}` });
  clients.push(client);
  return client;
};

// A file in the clear, which a backup tool copies through its own connection.
describe("restoring a libSQL file in the clear under a running app", () => {
  restoreContract({
    hot: true,
    create: async () => {
      const path = fresh("store");
      const copy = fresh("backup");
      const client = clientOf(path);
      return {
        storage: sqlite({ path, encrypt: false }),
        forgetLedger: sqlite({ path: fresh("ledger") }),
        // An online copy, as a backup tool takes it while the app runs.
        backUp: async () => {
          await client.execute(`VACUUM INTO '${copy}'`);
        },
        // In place, in one write transaction through the app's own engine, as `bounda restore`
        // does: the app sees the database as it was or as the copy has it, never in between.
        restore: async () => {
          const storage = sqlite({ path, encrypt: false });
          await storage.restore?.({ copy });
          return storage;
        },
      };
    },
  });
});

describe("restoring a libSQL file in the clear beside the lost one", () => {
  restoreContract({
    hot: false,
    create: async () => {
      let path = fresh("store");
      const copy = fresh("backup");
      return {
        storage: sqlite({ path, encrypt: false }),
        forgetLedger: sqlite({ path: fresh("ledger") }),
        backUp: async () => {
          await clientOf(path).execute(`VACUUM INTO '${copy}'`);
        },
        // A copy of the file, beside the old one, which Windows will not let go of while libSQL
        // still holds it.
        restore: async () => {
          path = fresh("restored");
          await copyFile(copy, path);
          return sqlite({ path, encrypt: false });
        },
      };
    },
  });
});

// A copy of the file as it lies on disk, its write-ahead log with it: what a backup of the
// volume takes, encrypted under the tenant's key as the file is.
const copyWithLog = async (from: string, to: string): Promise<void> => {
  await copyFile(from, to);
  await copyFile(`${from}-wal`, `${to}-wal`).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
};

describe("restoring a libSQL file encrypted under its tenant's key beside the lost one", () => {
  restoreContract({
    hot: false,
    create: async () => {
      let path = fresh("store");
      const copy = fresh("backup");
      return {
        storage: sqlite({ path }),
        forgetLedger: sqlite({ path: fresh("ledger") }),
        backUp: async () => {
          await copyWithLog(path, copy);
        },
        restore: async () => {
          path = fresh("restored");
          await copyWithLog(copy, path);
          return sqlite({ path });
        },
      };
    },
  });
});

describe("restoring a libSQL file encrypted under its tenant's key under a running app", () => {
  restoreContract({
    hot: true,
    create: async () => {
      let path = fresh("store");
      const copy = fresh("backup");
      return {
        storage: sqlite({ path }),
        forgetLedger: sqlite({ path: fresh("ledger") }),
        backUp: async () => {
          await copyWithLog(path, copy);
        },
        // Under the running app, in place through the adapter it opened, which holds the tenant's
        // keys the copy opens under; with the app stopped, beside the lost one.
        restore: async (opened) => {
          if (opened !== undefined) {
            await opened.restore?.({ copy });
            return opened;
          }
          path = fresh("restored");
          await copyWithLog(copy, path);
          return sqlite({ path });
        },
      };
    },
  });
});
