import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ConfigurationError, type Logger } from "@bounda-dev/core";
import type {
  FileEncryption,
  FileEncryptionState,
  FileKey,
  FileKeyAccess,
} from "@bounda-dev/core/adapter";
import { SQLITE_BUSY_TIMEOUT_MS } from "@bounda-dev/core/adapter/sqlite";
import { type Client, createClient } from "@libsql/client";

// Names the key a file was being encrypted from while the encryption runs: `null` in the clear.
const MARK_SUFFIX = ".bounda-encrypting";

interface Mark {
  readonly from: string | null;
}

const quoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;

const isNotADatabase = (error: unknown): boolean =>
  error instanceof Error && Reflect.get(error, "code") === "SQLITE_NOTADB";

// A connection to the file under `key`, `null` for none, or `null` when it does not open under
// it. A connection that failed lets go of the file at once; one that read holds it until
// collected, so the one that opens is the one that encrypts.
const openedUnder = async (path: string, key: string | null): Promise<Client | null> => {
  const client = createClient({
    url: `file:${path}`,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
    ...(key === null ? {} : { encryptionKey: key }),
  });
  try {
    await client.execute("SELECT count(*) FROM sqlite_master");
    return client;
  } catch (error) {
    client.close();
    if (isNotADatabase(error)) return null;
    throw error;
  }
};

// A file another tenant's database is bound to is left as it is: encrypting it under this
// tenant's key would take it from its own.
const refuseAnotherTenant = async (source: Client, tenancy: string, tenant: string) => {
  const bound = await source.execute(`SELECT tenant FROM ${tenancy}`).catch((error: unknown) => {
    if (error instanceof Error && /no such table/i.test(error.message)) return null;
    throw error;
  });
  const owner = bound?.rows[0]?.[0];
  if (typeof owner === "string" && owner !== tenant) {
    throw new ConfigurationError(
      `This database belongs to tenant ${owner}, and the app serves ${tenant}: give it its own database`,
    );
  }
};

const markOf = (path: string): Mark | null => {
  if (!existsSync(`${path}${MARK_SUFFIX}`)) return null;
  return JSON.parse(readFileSync(`${path}${MARK_SUFFIX}`, "utf8")) as Mark;
};

/**
 * Where an encryption in place stands between its steps: out of WAL, the mark written, the file
 * rekeyed, back in WAL.
 */
export type EncryptionStep = "unshared" | "marked" | "rekeyed" | "done";

// Encrypts the file in place under `to` on `source`, its one connection, open under `from`, and
// resolves to whether it did: not while another connection has the file open, which it finds out
// at once rather than after the busy timeout. A rekey cut short leaves a journal of the pages as
// they were, under `from`: the mark makes the next start open the file under it first, which
// rolls the journal back, since opening under any other key would play the journal back
// unreadable. `step` is told between the steps, for tests that cut it short there.
export const encryptInPlace = async (
  path: string,
  source: Client,
  from: FileKey | null,
  to: FileKey,
  step: (reached: EncryptionStep) => void = () => undefined,
): Promise<boolean> => {
  await source.execute("PRAGMA busy_timeout = 0");
  try {
    // Out of WAL, which a rekey cannot run in, only while no other connection has the file open.
    const mode = await source.execute("PRAGMA journal_mode = DELETE").catch((error: unknown) => {
      if (error instanceof Error && Reflect.get(error, "code") === "SQLITE_BUSY") return null;
      throw error;
    });
    if (String(mode?.rows[0]?.[0]).toLowerCase() !== "delete") return false;
    step("unshared");
    const mark: Mark = { from: from?.id ?? null };
    writeFileSync(`${path}${MARK_SUFFIX}`, JSON.stringify(mark), { flush: true });
    step("marked");
    await source.execute(`PRAGMA rekey = ${quoted(to.key)}`);
    step("rekeyed");
    await source.execute("PRAGMA journal_mode = WAL");
    rmSync(`${path}${MARK_SUFFIX}`, { force: true });
    step("done");
    return true;
  } finally {
    await source.execute(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  }
};

export interface PrepareFileArgs {
  readonly path: string;
  readonly keys: FileKeyAccess;
  readonly logger: Logger;
  /**
   * The table that binds the database to its tenant, quoted.
   */
  readonly tenancy: string;
}

export type PreparedFile =
  | {
      /**
       * The key the file opens under, `null` in the clear.
       */
      readonly under: FileKey | null;
      /**
       * The key in force, which the file is to move under when not yet.
       */
      readonly inForce: FileKey;
      /**
       * The connection the file was opened on: libSQL lets go of a closed one only once it is
       * collected, so the adapter keeps it as its own instead of leaving it to hold the file.
       */
      readonly client: Client;
    }
  | { readonly gone: true };

export interface PrepareFileFunction {
  (args: PrepareFileArgs): Promise<PreparedFile>;
}

/**
 * The key the file opens under, `null` in the clear, the key in force, and the connection it
 * opened on: under the key in force, which is then confirmed, once the file is encrypted under
 * it; `gone` when the tenant's file keys are and the file opens no more. A file in the clear, or under another of the tenant's
 * keys, is encrypted in place, which needs it to itself: while another connection has it open, it
 * opens as it is, pending, which the adapter encrypts once it can. libSQL lets go of a closed
 * connection only once it is collected, so an app stopped and started again in one process may
 * find its own.
 */
export const prepareFile: PrepareFileFunction = async ({ path, keys, logger, tenancy }) => {
  const current = await keys.current();
  if (current === null) return { gone: true };
  const others = await keys.previous();
  const mark = markOf(path);
  const marked =
    mark === null
      ? undefined
      : mark.from === null
        ? null
        : others.find(({ id }) => id === mark.from);
  if (marked === undefined && mark !== null) {
    throw new ConfigurationError(
      `The database file ${path} was being encrypted from a key its tenant's record no longer holds: restore the file from a copy`,
    );
  }
  // The key a cut-short encryption started from first, then the one in force, then the rest.
  const candidates: (FileKey | null)[] =
    marked === undefined ? [current, ...others, null] : [marked, current, ...others, null];
  for (const candidate of candidates) {
    const source = await openedUnder(path, candidate?.key ?? null);
    if (source === null) continue;
    try {
      if (candidate !== current) await refuseAnotherTenant(source, tenancy, keys.tenant);
      if (candidate !== current && !(await encryptInPlace(path, source, candidate, current))) {
        logger.warn(
          candidate === null
            ? "bounda left a database file in the clear for now: another connection has it open, so the app encrypts it under its tenant's key once none has"
            : "bounda left a database file under its tenant's earlier key for now: another connection has it open, so the app encrypts it under the key in force once none has",
          { file: path },
        );
        return { under: candidate, inForce: current, client: source };
      }
      // Its encryption, if one ran, is done.
      rmSync(`${path}${MARK_SUFFIX}`, { force: true });
      await keys.confirm(current.id);
      return { under: current, inForce: current, client: source };
    } catch (error) {
      source.close();
      throw error;
    }
  }
  throw new ConfigurationError(
    `The database file ${path} opens under none of its tenant's keys: it is another tenant's, or its keys were destroyed`,
  );
};

export interface FileEncryptionOfArgs {
  readonly path: string;
  readonly database: string;
  readonly keys: FileKeyAccess;
  /**
   * The key the file is under, `null` in the clear.
   */
  readonly under: FileKey | null;
  readonly inForce: FileKey;
  /**
   * Runs `task` on the adapter's connection with no other statement of its alongside.
   */
  readonly alone: <T>(task: (client: Client) => Promise<T>) => Promise<T>;
  /**
   * Told the key the file is encrypted under from now on, for the connections opened later.
   */
  readonly encrypted: (key: string) => void;
}

export interface FileEncryptionOfFunction {
  (args: FileEncryptionOfArgs): FileEncryption;
}

// Where the file of an adapter opened through the tenant's keys stands against the key in force,
// read again on `refresh`, and its encryption under it once no other connection has the file open.
export const fileEncryptionOf: FileEncryptionOfFunction = ({
  path,
  database,
  keys,
  under: opened,
  inForce: first,
  alone,
  encrypted,
}) => {
  let under = opened;
  let inForce = first;
  const state = (): FileEncryptionState =>
    under === null ? "clear" : under.id === inForce.id ? "current" : "earlier";
  return {
    database,
    state,
    refresh: async () => {
      inForce = (await keys.current()) ?? inForce;
      return state();
    },
    settle: async () => {
      const from = under;
      const to = inForce;
      if (
        state() !== "current" &&
        (await alone((client) => encryptInPlace(path, client, from, to)))
      ) {
        under = to;
        encrypted(to.key);
        await keys.confirm(to.id);
      }
      return state();
    },
  };
};
