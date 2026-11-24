import type { FileKey, FileKeyAccess } from "../../adapter/storage/encrypted-file.ts";
import type {
  StoredFileKey,
  TenantKeyRecord,
  TenantKeyStore,
} from "../../adapter/storage/tenant-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConfigurationError, TenantFrozenError } from "../../contracts/errors.ts";
import { runtimeText } from "../shared/runtime-text.ts";
import { fromBase64, withRawKey } from "./crypto.ts";
import { newFileKey, unwrapFileKey, wrapFileKey } from "./file-key-crypto.ts";
import type { CryptoKeyWrapper } from "./key-wrapper.ts";
import { generateTenantVersion, newKid, openStoredTenantKey } from "./tenant-keys.ts";

// How many times a write that lost the race to another writer reads the record again.
const PUT_ATTEMPTS = 5;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

// The one place a key's bytes reach JavaScript as text: the engine opens the file with nothing
// else. The bytes are zeroed once read; the text goes straight to the engine and is kept nowhere.
const fileKeyText = (key: CryptoKey): Promise<string> => withRawKey(key, async (raw) => hex(raw));

export interface FileKeys {
  /**
   * The databases whose file is the record's own: all of them when this start created the
   * record, those it held a key for already otherwise. A file given its first key by a record
   * that existed belongs to another database, or is new.
   */
  readonly owned: ReadonlySet<string>;
  forDatabase(database: string): FileKeyAccess;
}

export interface OpenFileKeysArgs {
  readonly store: TenantKeyStore;
  readonly master: CryptoKeyWrapper;
  readonly tenant: string;
  readonly clock: Clock;
  /**
   * The databases whose files are encrypted, by the names their adapters' `encryptedFile` give.
   */
  readonly databases: readonly string[];
}

export interface OpenFileKeysFunction {
  (args: OpenFileKeysArgs): Promise<FileKeys>;
}

const filesOf = (record: TenantKeyRecord, database: string): readonly StoredFileKey[] =>
  (record.forgotten?.files ?? record.files ?? []).filter((file) => file.database === database);

/**
 * The keys of the tenant's encrypted database files, read before any of them opens: the tenant's
 * record is created when the store holds none, with its first version and a key for each
 * database, and a database without a key is given one under the version in force.
 */
export const openFileKeys: OpenFileKeysFunction = async ({
  store,
  master,
  tenant,
  clock,
  databases,
}) => {
  // A new key for each of `databases`, wrapped under the version `under`.
  const keysFor = (
    names: readonly string[],
    under: { readonly kid: string; readonly key: CryptoKey },
    at: Date,
  ): Promise<StoredFileKey[]> =>
    Promise.all(
      names.map(async (database) => ({
        database,
        id: newKid(),
        key: await wrapFileKey({ key: await newFileKey(), under: under.key }),
        wrappedBy: under.kid,
        createdAt: at.toISOString(),
      })),
    );

  const readRecord = async (): Promise<{
    readonly record: TenantKeyRecord;
    readonly owned: readonly string[];
  }> => {
    for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt += 1) {
      const read = await store.get(tenant);
      const at = clock.now();
      if (read === null) {
        const version = await generateTenantVersion(master, at);
        const fresh: TenantKeyRecord = {
          store: newKid(),
          keys: [version.stored],
          forgotten: null,
          files: await keysFor(databases, { kid: version.stored.kid, key: version.key }, at),
        };
        if (await store.put(tenant, fresh, null)) return { record: fresh, owned: databases };
        continue;
      }
      const missing = databases.filter((database) => filesOf(read, database).length === 0);
      const [version] = read.keys;
      // A forgotten tenant holds no version: its files are given no key.
      const held = databases.filter((database) => !missing.includes(database));
      if (missing.length === 0 || version === undefined) return { record: read, owned: held };
      if (read.frozenAt !== undefined) throw new TenantFrozenError(tenant, read.frozenAt);
      const under = await openStoredTenantKey({ stored: version, master, tenant });
      const { revision, ...current } = read;
      const added = await keysFor(missing, { kid: version.kid, key: under }, at);
      const next: TenantKeyRecord = { ...current, files: [...(read.files ?? []), ...added] };
      if (await store.put(tenant, next, revision)) return { record: next, owned: held };
    }
    throw runtimeText(
      new ConfigurationError(
        `The record of tenant ${tenant}'s key kept changing while its files' keys were read`,
      ),
    );
  };
  const { record: read, owned } = await readRecord();

  const open = async (stored: StoredFileKey, record: TenantKeyRecord): Promise<FileKey> => {
    const version = record.keys.find(({ kid }) => kid === stored.wrappedBy);
    const key =
      version === undefined
        ? await master.unwrap({
            kid: stored.wrappedBy,
            wrapped: fromBase64(stored.key),
            extractable: true,
            kind: "personal",
          })
        : await unwrapFileKey({
            wrapped: stored.key,
            under: await openStoredTenantKey({ stored: version, master, tenant }),
          });
    return { id: stored.id, key: await fileKeyText(key) };
  };

  // The record as the store holds it now: a rotation since the start puts another key in force.
  const latest = async (): Promise<TenantKeyRecord> => (await store.get(tenant)) ?? read;

  return {
    owned: new Set(owned),
    forDatabase: (database) => ({
      tenant,
      current: async () => {
        const now = await latest();
        // A forgotten tenant's copy restored under another name opens under its original's key.
        const [stored] =
          now.forgotten === null
            ? filesOf(now, database)
            : [...filesOf(now, database), ...(now.forgotten.files ?? [])];
        if (stored === undefined) {
          if (now.forgotten !== null) return null;
          throw runtimeText(
            new ConfigurationError(
              `Tenant ${tenant}'s record holds no key for the file of its database ${database}`,
            ),
          );
        }
        return open(stored, now);
      },
      previous: async () => {
        const now = await latest();
        const own = filesOf(now, database).slice(1);
        const others = (now.forgotten?.files ?? now.files ?? []).filter(
          (file) => file.database !== database,
        );
        return Promise.all([...own, ...others].map((file) => open(file, now)));
      },
      confirm: async (id) => {
        for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt += 1) {
          const record = await store.get(tenant);
          if (record === null || record.forgotten !== null) return;
          const files = record.files ?? [];
          const moved = files.find((file) => file.database === database && file.id === id);
          if (moved === undefined || moved.appliedAt !== undefined) return;
          // Left to the next open: until then, retiring keeps the file's earlier keys.
          if (record.frozenAt !== undefined) return;
          const applied = { ...moved, appliedAt: clock.now().toISOString() };
          const { revision, ...current } = record;
          const next = {
            ...current,
            files: files.map((file) => (file === moved ? applied : file)),
          };
          if (await store.put(tenant, next, revision)) return;
        }
      },
    }),
  };
};
