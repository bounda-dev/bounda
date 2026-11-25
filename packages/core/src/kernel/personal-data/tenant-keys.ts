import type { Tenancy, TenancyStore } from "../../adapter/storage/tenancy-store.ts";
import type {
  PendingRecipientDeclaration,
  StoredFileKey,
  StoredTenantKey,
  TenantForgetting,
  TenantKeyRecord,
  TenantKeyStore,
  VersionedTenantKeyRecord,
} from "../../adapter/storage/tenant-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import {
  ConfigurationError,
  TenantForgottenError,
  TenantFrozenError,
} from "../../contracts/errors.ts";
import { runtimeText } from "../shared/runtime-text.ts";
import { fromBase64, generateWrappableTenantKey, tenantFingerprintOf, toBase64 } from "./crypto.ts";
import { newFileKey, unwrapFileKey, wrapFileKey } from "./file-key-crypto.ts";
import type { CryptoKeyWrapper } from "./key-wrapper.ts";
import { rewrapRecordUnderMaster } from "./master-rotation.ts";
import { UNWRAPPED_KEY_TTL_MS } from "./wrapped-keys.ts";

/**
 * The tenant an app serves when nothing names one: a single-tenant app gets a tenant key too, so
 * every app's keys stand in the same hierarchy.
 */
export const DEFAULT_TENANT = "default";

// How many times a write that lost the race to another writer reads the record again.
const PUT_ATTEMPTS = 5;

const KID_BYTES = 12;

/**
 * A version of the tenant's key, ready to wrap and unwrap with, and the id the keys it wraps name.
 */
export interface TenantKeyVersion {
  readonly kid: string;
  readonly key: CryptoKey;
}

/**
 * Where the tenant's key stands: whether it was forgotten, the version in force and the older
 * ones the record still holds, and the master key the versions are wrapped under.
 */
export interface TenantKeyStatus {
  readonly tenant: string;
  /**
   * `null` while the tenant is not forgotten.
   */
  readonly forgottenAt: string | null;
  /**
   * `null` once the tenant is forgotten.
   */
  readonly kid: string | null;
  readonly previous: readonly string[];
  readonly master: {
    readonly kid: string;
    readonly previous: readonly string[];
    /**
     * How many versions are wrapped under a master key other than the one in force.
     */
    readonly pending: number;
  };
}

/**
 * The keys of the tenant an app serves, as the tenant key store keeps them. Every version is
 * unwrapped once read and kept, as a key that cannot be exported, for `UNWRAPPED_KEY_TTL_MS`;
 * the record is read again past it, so a version rotated in, retired or forgotten elsewhere is
 * seen within that time.
 */
export interface TenantKeys {
  readonly tenant: string;
  /**
   * The id of the database the tenant's keys belong to.
   */
  readonly store: string;
  /**
   * The version in force. Rejects with `TenantForgottenError` once the tenant is forgotten.
   */
  current(): Promise<TenantKeyVersion>;
  /**
   * The version of that id, `null` when the record has none. Rejects with `TenantForgottenError`
   * once the tenant is forgotten.
   */
  keyOf(kid: string): Promise<CryptoKey | null>;
  /**
   * Whether the record read last holds a version of that id. Throws `TenantForgottenError` once
   * the tenant is forgotten, as that record says.
   */
  knows(kid: string): boolean;
  /**
   * The ids of the version in force and of the older ones the record still holds, and when the
   * one in force was created.
   */
  kids(): Promise<{
    readonly kid: string;
    readonly previous: readonly string[];
    readonly since: string;
  }>;
  /**
   * The forgetting, as the record read last says, `null` while the tenant is not forgotten.
   */
  forgotten(): TenantForgetting | null;
  /**
   * Reads the record again now, and resolves to the forgetting it holds, if any.
   */
  refresh(): Promise<TenantForgetting | null>;
  /**
   * Puts a new version in force, with a new key for each of the tenant's database files, which
   * each file is encrypted under the next time it opens, and resolves to the version's id.
   */
  rotate(): Promise<string>;
  /**
   * Removes every version but the one in force, and the earlier keys of each database file found
   * encrypted under its new one, and resolves to the ids of the versions it removed: what was
   * wrapped under them, and the copies of the files under those keys, never open again.
   */
  retire(): Promise<readonly string[]>;
  /**
   * Destroys every version, recording the forgetting, and resolves to the forgetting the record
   * holds, this one or an earlier. The keys of the tenant's database files are kept, under the
   * master key, until `releaseFiles`: the notices to its recipients are still to be sent.
   */
  forget(forgetting: TenantForgetting): Promise<TenantForgetting>;
  // Since when the tenant is frozen, as the record read last says; `null` while it is not.
  frozenAt(): string | null;
  // Records the tenant frozen since `at`, unless it is already, and resolves to since when it is.
  // Rejects with `TenantForgottenError` once the tenant is forgotten.
  freeze(at: string): Promise<string>;
  // Lifts what `freeze` recorded.
  unfreeze(): Promise<void>;
  // The declarations of recipients the record held as read last, oldest first.
  pendingRecipients(): readonly PendingRecipientDeclaration[];
  // Adds `declaration` after the others, removing one that declares the same, unless the last
  // does already. Rejects with `TenantForgottenError` once the tenant is forgotten.
  addPendingRecipients(declaration: PendingRecipientDeclaration): Promise<void>;
  // Removes the declarations of `ids`, forgotten or not.
  removePendingRecipients(ids: readonly string[]): Promise<void>;
  /**
   * Destroys the keys of a forgotten tenant's database files, and resolves to whether the record
   * held any: the files, and every copy of them, never open again.
   */
  releaseFiles(): Promise<boolean>;
  /**
   * Rewraps under the master key in force every version wrapped under a previous one, and
   * resolves to how many it rewrapped.
   */
  rewrapUnderMaster(): Promise<number>;
  /**
   * Whether the record read last holds a version wrapped under another master key than the one
   * in force.
   */
  underPreviousMaster(): boolean;
  status(): Promise<TenantKeyStatus>;
  /**
   * Drops every version kept.
   */
  close(): void;
}

export interface OpenTenantKeysArgs {
  readonly tenant: string;
  readonly store: TenantKeyStore;
  readonly tenancy: TenancyStore;
  readonly master: CryptoKeyWrapper;
  readonly clock: Clock;
  /**
   * Whether the database holds a key wrapped under a version of a tenant key, rather than under a
   * master key or none: a database whose record is missing then lost its keys with it.
   */
  readonly holdsTenantWrapped: (legacy: readonly string[]) => Promise<boolean>;
  /**
   * Whether the store is the storage's own, gone with the process as its one database is: a
   * database in memory opened anew takes over the tenant's record of the one before.
   */
  readonly ephemeral?: boolean;
  /**
   * Whether the database is the record's own though it holds no binding yet: the record was
   * created with its files' keys by this start, or its file opened under one of them. It is bound
   * to the record then.
   */
  readonly claims?: boolean;
  /**
   * Defaults to `UNWRAPPED_KEY_TTL_MS`.
   */
  readonly ttlMs?: number;
}

export interface OpenTenantKeysFunction {
  (args: OpenTenantKeysArgs): Promise<TenantKeys>;
}

const base64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_");

export const newKid = (): string => base64Url(crypto.getRandomValues(new Uint8Array(KID_BYTES)));

export interface Generated {
  readonly stored: StoredTenantKey;
  readonly key: CryptoKey;
}

export const generateTenantVersion = async (
  master: CryptoKeyWrapper,
  at: Date,
): Promise<Generated> => {
  const exportable = await generateWrappableTenantKey();
  const fingerprint = await tenantFingerprintOf(exportable);
  const { wrapped, key } = await master.wrap(exportable);
  return {
    stored: {
      kid: newKid(),
      fingerprint,
      key: toBase64(wrapped),
      wrappedBy: master.kid,
      createdAt: at.toISOString(),
    },
    key,
  };
};

export interface OpenStoredTenantKeyArgs {
  readonly stored: StoredTenantKey;
  readonly master: CryptoKeyWrapper;
  readonly tenant: string;
}

export interface OpenStoredTenantKeyFunction {
  (args: OpenStoredTenantKeyArgs): Promise<CryptoKey>;
}

// A version of the tenant's key unwrapped under the master key it names, checked against its
// fingerprint, as a key that cannot be exported.
export const openStoredTenantKey: OpenStoredTenantKeyFunction = async ({
  stored,
  master,
  tenant,
}) => {
  if (!masterKids(master).includes(stored.wrappedBy)) {
    throw runtimeText(
      new ConfigurationError(
        `Tenant ${tenant}'s key is wrapped under the master key ${stored.wrappedBy}, which is neither the key wrapper's key nor one of its previous ones`,
      ),
    );
  }
  const opened = await master.unwrap({
    kid: stored.wrappedBy,
    wrapped: fromBase64(stored.key),
    extractable: false,
    kind: "tenant",
  });
  if ((await tenantFingerprintOf(opened)) !== stored.fingerprint) {
    throw runtimeText(
      new ConfigurationError(
        `Tenant ${tenant}'s key unwrapped under ${stored.wrappedBy} does not match its fingerprint: the key wrapper returned another key`,
      ),
    );
  }
  return opened;
};

const masterKids = (master: CryptoKeyWrapper): readonly string[] => [
  master.kid,
  ...master.previous,
];

// The record the store holds for the tenant, created when it holds none, checked against the
// database's binding: a tenant's key belongs to one database, whatever copies of it are made.
const recordFor = async (
  args: OpenTenantKeysArgs,
): Promise<{
  readonly record: VersionedTenantKeyRecord;
  readonly binding: Tenancy | null;
  readonly fresh: Generated | null;
}> => {
  const { tenant, store, tenancy, master, clock, holdsTenantWrapped } = args;
  let binding = await tenancy.get();
  if (binding !== null && binding.tenant !== tenant) {
    throw runtimeText(
      new ConfigurationError(
        `This database belongs to tenant ${binding.tenant}, and the app serves ${tenant}: give it its own database`,
      ),
    );
  }
  for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt += 1) {
    const record = await store.get(tenant);
    // A database in memory opened anew lost the one before: it takes over the tenant's record.
    const lost = args.ephemeral === true && binding === null && record?.forgotten === null;
    // The record's own database binds itself to it; a forgotten tenant's, even an empty one, too,
    // so it says whose forgetting it is.
    if (
      record !== null &&
      binding === null &&
      (record.forgotten !== null || args.claims === true)
    ) {
      binding = await tenancy.bind({
        tenant,
        store: record.store,
        boundAt: clock.now().toISOString(),
      });
    }
    if (record !== null && !lost) {
      if (binding === null && record.forgotten === null) {
        throw runtimeText(
          new ConfigurationError(
            `The tenant key store holds the key of tenant ${tenant} for another database: give each database its own tenant, or point runtime.personalData.tenantKeys at this one's store`,
          ),
        );
      }
      if (binding !== null && binding.store !== record.store) {
        throw runtimeText(
          new ConfigurationError(
            `The tenant key store holds the key of tenant ${tenant} for another database than this one: give each database its own tenant, or point runtime.personalData.tenantKeys at this one's store`,
          ),
        );
      }
      return { record, binding, fresh: null };
    }
    if (binding !== null && (await holdsTenantWrapped(masterKids(master)))) {
      throw runtimeText(
        new ConfigurationError(
          `The tenant key store holds no key for tenant ${tenant}, whose database holds keys wrapped under one: point runtime.personalData.tenantKeys at the store that holds it`,
        ),
      );
    }
    const at = clock.now();
    // Bound first: a start that stops before the record is written binds the same id next time.
    binding ??= await tenancy.bind({ tenant, store: newKid(), boundAt: at.toISOString() });
    const fresh = await generateTenantVersion(master, at);
    const created: TenantKeyRecord = {
      store: binding.store,
      keys: [fresh.stored],
      forgotten: null,
    };
    const expected = record?.revision ?? null;
    if (await store.put(tenant, created, expected)) {
      return { record: { ...created, revision: (expected ?? 0) + 1 }, binding, fresh };
    }
  }
  throw runtimeText(
    new ConfigurationError(`The record of tenant ${tenant}'s key kept changing while it was read`),
  );
};

interface Kept {
  readonly key: Promise<CryptoKey>;
  readonly at: number;
}

/**
 * Opens the tenant's keys, creating the first version when the store holds none. Refuses a
 * database bound to another tenant, a record that belongs to another database, and a database
 * whose keys are wrapped under a tenant key the store does not hold.
 */
export const openTenantKeys: OpenTenantKeysFunction = async (args) => {
  const { tenant, store, master, clock, ttlMs = UNWRAPPED_KEY_TTL_MS } = args;
  const opened = await recordFor(args);
  let record: VersionedTenantKeyRecord = opened.record;
  let readAt = clock.now().getTime();
  const kept = new Map<string, Kept>();
  if (opened.fresh !== null) {
    kept.set(opened.fresh.stored.kid, { key: Promise.resolve(opened.fresh.key), at: readAt });
  }

  const forgottenError = (forgetting: TenantForgetting): TenantForgottenError =>
    new TenantForgottenError(tenant, forgetting.at);

  // A wall clock set back makes a key look younger than it can be: it is taken as expired.
  const stale = (at: number, now: number): boolean => now - at >= ttlMs || at > now;

  const reread = async (): Promise<VersionedTenantKeyRecord> => {
    const read = await store.get(tenant);
    if (read === null) {
      throw runtimeText(
        new ConfigurationError(`The tenant key store no longer holds a key for tenant ${tenant}`),
      );
    }
    record = read;
    readAt = clock.now().getTime();
    const live = new Set(read.keys.map(({ kid }) => kid));
    for (const kid of [...kept.keys()]) if (!live.has(kid)) kept.delete(kid);
    return read;
  };

  const fresh = async (): Promise<VersionedTenantKeyRecord> => {
    const now = clock.now().getTime();
    const read = stale(readAt, now) ? await reread() : record;
    if (read.forgotten !== null) {
      kept.clear();
      throw forgottenError(read.forgotten);
    }
    return read;
  };

  const unwrapped = (stored: StoredTenantKey): Promise<CryptoKey> => {
    const now = clock.now().getTime();
    const found = kept.get(stored.kid);
    if (found !== undefined && !stale(found.at, now)) return found.key;
    const key = openStoredTenantKey({ stored, master, tenant });
    const entry: Kept = { key, at: now };
    kept.set(stored.kid, entry);
    key.catch(() => {
      if (kept.get(stored.kid) === entry) kept.delete(stored.kid);
    });
    return key;
  };

  // Writes what `change` makes of the record, reading it again whenever another writer came first.
  const update = async (
    change: (
      current: VersionedTenantKeyRecord,
    ) => TenantKeyRecord | null | Promise<TenantKeyRecord | null>,
  ): Promise<VersionedTenantKeyRecord> => {
    for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt += 1) {
      const current = await reread();
      const next = await change(current);
      if (next === null) return current;
      if (await store.put(tenant, next, current.revision)) {
        record = { ...next, revision: current.revision + 1 };
        return record;
      }
    }
    throw runtimeText(
      new ConfigurationError(
        `The record of tenant ${tenant}'s key kept changing while it was written`,
      ),
    );
  };

  const live = (current: VersionedTenantKeyRecord): readonly StoredTenantKey[] => {
    if (current.forgotten !== null) throw forgottenError(current.forgotten);
    return current.keys;
  };

  // What a version put in force or retired needs: neither while the tenant is frozen.
  const writable = (current: VersionedTenantKeyRecord): readonly StoredTenantKey[] => {
    const keys = live(current);
    if (current.frozenAt !== undefined) throw new TenantFrozenError(tenant, current.frozenAt);
    return keys;
  };

  const inForce = (keys: readonly StoredTenantKey[]): StoredTenantKey => {
    const [first] = keys;
    if (first === undefined) {
      throw runtimeText(
        new ConfigurationError(`The tenant key store holds no version of tenant ${tenant}'s key`),
      );
    }
    return first;
  };

  // The record's file keys, every one wrapped under `to`: a version's or, once forgotten, the
  // master key's.
  const filesUnder = async (
    current: VersionedTenantKeyRecord,
    to: { readonly kid: string; readonly key: CryptoKey } | "master",
  ): Promise<readonly StoredFileKey[]> => {
    const versions = new Map(current.keys.map((version) => [version.kid, version]));
    // Forgetting never fails on a key no version opens any more: that file opens no more anyway.
    const files = (current.files ?? []).filter(
      (file) => to !== "master" || versions.has(file.wrappedBy),
    );
    return Promise.all(
      files.map(async (file) => {
        const version = versions.get(file.wrappedBy);
        if (version === undefined) {
          throw runtimeText(
            new ConfigurationError(
              `The key of tenant ${tenant}'s file of ${file.database} is wrapped under ${file.wrappedBy}, a version the record no longer holds`,
            ),
          );
        }
        const key = await unwrapFileKey({ wrapped: file.key, under: await unwrapped(version) });
        if (to === "master") {
          const { wrapped } = await master.wrap(key);
          return { ...file, key: toBase64(wrapped), wrappedBy: master.kid };
        }
        return { ...file, key: await wrapFileKey({ key, under: to.key }), wrappedBy: to.kid };
      }),
    );
  };

  const withFiles = (current: TenantKeyRecord, files: readonly StoredFileKey[]): TenantKeyRecord =>
    files.length === 0 ? current : { ...current, files };

  return {
    tenant,
    store: record.store,
    current: async () => {
      const stored = inForce((await fresh()).keys);
      return { kid: stored.kid, key: await unwrapped(stored) };
    },
    knows: (kid) => {
      if (record.forgotten !== null) throw forgottenError(record.forgotten);
      return record.keys.some((version) => version.kid === kid);
    },
    keyOf: async (kid) => {
      const stored = (await fresh()).keys.find((version) => version.kid === kid);
      return stored === undefined ? null : unwrapped(stored);
    },
    kids: async () => {
      const { keys } = await fresh();
      const current = inForce(keys);
      return {
        kid: current.kid,
        previous: keys.slice(1).map(({ kid }) => kid),
        since: current.createdAt,
      };
    },
    forgotten: () => record.forgotten,
    frozenAt: () => record.frozenAt ?? null,
    refresh: async () => {
      const read = await reread();
      if (read.forgotten !== null) kept.clear();
      return read.forgotten;
    },
    rotate: async () => {
      const at = clock.now();
      const generated = await generateTenantVersion(master, at);
      await update(async (current) => {
        const keys = [generated.stored, ...writable(current)];
        const to = { kid: generated.stored.kid, key: generated.key };
        const files = await filesUnder(current, to);
        const fresh = await Promise.all(
          [...new Set(files.map(({ database }) => database))].map(async (database) => ({
            database,
            id: newKid(),
            key: await wrapFileKey({ key: await newFileKey(), under: to.key }),
            wrappedBy: to.kid,
            createdAt: at.toISOString(),
          })),
        );
        return withFiles({ ...current, keys }, [...fresh, ...files]);
      });
      kept.set(generated.stored.kid, {
        key: Promise.resolve(generated.key),
        at: clock.now().getTime(),
      });
      return generated.stored.kid;
    },
    retire: async () => {
      let retired: readonly string[] = [];
      await update(async (current) => {
        const keys = writable(current);
        retired = keys.slice(1).map(({ kid }) => kid);
        if (retired.length === 0) return null;
        const version = inForce(keys);
        const to = { kid: version.kid, key: await unwrapped(version) };
        const files = await filesUnder(current, to);
        const inForceOf = new Map<string, StoredFileKey>();
        for (const file of files)
          if (!inForceOf.has(file.database)) inForceOf.set(file.database, file);
        // A file not yet found under its new key still needs the earlier ones to open.
        const kept = files.filter((file) => {
          const first = inForceOf.get(file.database);
          return file === first || first?.appliedAt === undefined;
        });
        return withFiles({ ...current, keys: [version] }, kept);
      });
      for (const kid of retired) kept.delete(kid);
      return retired;
    },
    forget: async (forgetting) => {
      const written = await update(async (current) => {
        if (current.forgotten !== null) return null;
        const files = await filesUnder(current, "master");
        // A forgetting ends a freeze: nothing is written again either way.
        const { files: _, frozenAt: __, ...rest } = current;
        return {
          ...rest,
          keys: [],
          forgotten: files.length === 0 ? forgetting : { ...forgetting, files },
        };
      });
      kept.clear();
      return written.forgotten ?? forgetting;
    },
    freeze: async (at) => {
      const written = await update((current) => {
        live(current);
        return current.frozenAt === undefined ? { ...current, frozenAt: at } : null;
      });
      return written.frozenAt ?? at;
    },
    unfreeze: async () => {
      await update((current) => {
        if (current.frozenAt === undefined) return null;
        const { frozenAt: _, ...rest } = current;
        return rest;
      });
    },
    pendingRecipients: () => record.pendingRecipients ?? [],
    addPendingRecipients: async (declaration) => {
      const { id: _, at: __, ...declares } = declaration;
      const same = JSON.stringify(declares);
      const declaring = ({ id: _, at: __, ...held }: PendingRecipientDeclaration): string =>
        JSON.stringify(held);
      await update((current) => {
        live(current);
        const held = current.pendingRecipients ?? [];
        const last = held.at(-1);
        if (last !== undefined && declaring(last) === same) return null;
        return {
          ...current,
          pendingRecipients: [...held.filter((each) => declaring(each) !== same), declaration],
        };
      });
    },
    removePendingRecipients: async (ids) => {
      await update((current) => {
        const held = current.pendingRecipients;
        if (held === undefined) return null;
        const kept = held.filter(({ id }) => !ids.includes(id));
        if (kept.length === held.length) return null;
        const { pendingRecipients: _, ...rest } = current;
        return kept.length === 0 ? rest : { ...rest, pendingRecipients: kept };
      });
    },
    releaseFiles: async () => {
      let released = false;
      await update((current) => {
        // A forgetting keeps the files' keys only when the tenant had any.
        if (current.forgotten?.files === undefined) return null;
        released = true;
        const { files: _, ...forgetting } = current.forgotten;
        return { ...current, forgotten: forgetting };
      });
      return released;
    },
    rewrapUnderMaster: async () => {
      live(await reread());
      const count = await rewrapRecordUnderMaster({ store, master, tenant });
      await reread();
      return count;
    },
    underPreviousMaster: () =>
      record.forgotten === null && record.keys.some(({ wrappedBy }) => wrappedBy !== master.kid),
    status: async () => {
      const current = await reread();
      const keys = current.forgotten === null ? current.keys : [];
      const [first, ...older] = keys;
      return {
        tenant,
        forgottenAt: current.forgotten?.at ?? null,
        kid: first?.kid ?? null,
        previous: older.map(({ kid }) => kid),
        master: {
          kid: master.kid,
          previous: master.previous,
          pending: keys.filter(({ wrappedBy }) => wrappedBy !== master.kid).length,
        },
      };
    },
    close: () => kept.clear(),
  };
};
