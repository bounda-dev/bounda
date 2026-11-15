import { type Adapter, isAdapter } from "../../adapter/adapter.ts";
import type { AdapterDefinition } from "../../adapter/adapter-definition.ts";
import type { EncryptedFile } from "../../adapter/storage/encrypted-file.ts";
import type { TenantKeyStore } from "../../adapter/storage/tenant-key-store.ts";
import { resolveConfig } from "../../config/schema.ts";
import type { Config } from "../../config/types.ts";
import { type Clock, systemClock } from "../../contracts/clock.ts";
import { type Logger, silentLogger } from "../../contracts/logger.ts";
import type { AppEnv } from "../../register/index.ts";
import { openFileKeys } from "./file-keys.ts";
import { keySourcesOf } from "./key-hierarchy.ts";
import { buildKeyWrapper, type CryptoKeyWrapper } from "./key-wrapper.ts";
import { openTenantKeyStore, type TenantKeySource } from "./tenant-key-source.ts";
import { DEFAULT_TENANT } from "./tenant-keys.ts";

export interface OpenEncryptedFilesArgs {
  readonly config: Config;
  readonly master: CryptoKeyWrapper | null;
  readonly tenantKeys: TenantKeySource | null;
  readonly tenant: string;
  readonly env: AppEnv;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface EncryptedFiles {
  /**
   * `config` with every adapter over an encrypted file swapped for the one opened under its key.
   */
  readonly config: Config;
  /**
   * The tenant key store the files' keys were read from, for the key hierarchy to go on with;
   * `null` when no file is encrypted.
   */
  readonly store: TenantKeyStore | null;
  /**
   * Whether the storage's database is an encrypted file the record already held a key for, or one
   * this start created the record with: the record's own, which binds itself to it.
   */
  readonly claims: boolean;
  /**
   * The adapters opened under the tenant's keys, in `config`.
   */
  readonly encrypted: ReadonlySet<AdapterDefinition>;
}

export interface OpenEncryptedFilesFunction {
  (args: OpenEncryptedFilesArgs): Promise<EncryptedFiles>;
}

interface EncryptingAdapter extends Adapter {
  readonly encryptedFile: EncryptedFile;
}

const encrypting = (definition: AdapterDefinition): definition is EncryptingAdapter =>
  isAdapter(definition) && definition.encryptedFile !== undefined;

/**
 * Opens, before anything reads them, the storage's and the read models' files their adapters
 * encrypt under keys of the tenant's, reading the keys from its record and creating it when the
 * store holds none. Without a key wrapper and a tenant key store, nothing is encrypted.
 */
export const openEncryptedFiles: OpenEncryptedFilesFunction = async ({
  config,
  master,
  tenantKeys,
  tenant,
  env,
  clock,
  logger,
}) => {
  const adapters = [
    ...new Set([config.storage, ...Object.values(config.readModels ?? {})].filter(encrypting)),
  ];
  if (master === null || tenantKeys === null || adapters.length === 0) {
    return { config, store: null, claims: false, encrypted: new Set() };
  }
  const store = await openTenantKeyStore({ source: tenantKeys, storage: config.storage, env });
  try {
    const databases = [...new Set(adapters.map(({ encryptedFile }) => encryptedFile.database))];
    const keys = await openFileKeys({ store, master, tenant, clock, databases });
    const opened = new Map<AdapterDefinition, Adapter>();
    // One at a time: two adapters over the same file must not encrypt it at once.
    for (const adapter of adapters) {
      const { encryptedFile: file } = adapter;
      opened.set(adapter, await file.open({ keys: keys.forDatabase(file.database), logger }));
    }
    const swapped = (definition: AdapterDefinition): AdapterDefinition =>
      opened.get(definition) ?? definition;
    return {
      config: {
        ...config,
        storage: swapped(config.storage),
        ...(config.readModels === undefined
          ? {}
          : {
              readModels: Object.fromEntries(
                Object.entries(config.readModels).map(([name, definition]) => [
                  name,
                  swapped(definition),
                ]),
              ),
            }),
      },
      store,
      claims: encrypting(config.storage) && keys.owned.has(config.storage.encryptedFile.database),
      encrypted: new Set(opened.values()),
    };
  } catch (error) {
    await store.close?.().catch(() => undefined);
    throw error;
  }
};

export interface WithEncryptedFilesArgs<T> {
  /**
   * The project's configuration.
   */
  readonly config: Config;
  /**
   * The environment the key wrapper and the tenant key store read, such as `process.env`.
   */
  readonly env: AppEnv;
  /**
   * The tenant whose files to open. Defaults to `DEFAULT_TENANT`.
   */
  readonly tenant?: string;
  /**
   * Told when a file stays under its earlier key, or in the clear, for now. Defaults to none.
   */
  readonly logger?: Logger;
  /**
   * Runs on the configuration whose adapters open their files under the tenant's keys.
   */
  readonly work: (config: Config) => Promise<T>;
}

export interface WithEncryptedFilesFunction {
  <T>(args: WithEncryptedFilesArgs<T>): Promise<T>;
}

/**
 * Runs `work` on the configuration with every database file its adapters encrypt opened under the
 * tenant's keys: for a tool that reads or migrates the databases without starting the app, as
 * `bounda migrate` does. A file in the clear, or under a previous key, is encrypted under the key
 * in force first. Without a key wrapper and a tenant key store, `work` gets the configuration as
 * it is.
 */
export const withEncryptedFiles: WithEncryptedFilesFunction = async ({
  config,
  env,
  tenant = DEFAULT_TENANT,
  logger = silentLogger,
  work,
}) => {
  const resolved = resolveConfig(config);
  if (!isAdapter(resolved.storage)) return work(config);
  const sources = keySourcesOf({
    storage: resolved.storage,
    personalData: resolved.runtime.personalData,
  });
  const master =
    sources.keyWrapper === null
      ? null
      : await buildKeyWrapper({ definition: sources.keyWrapper, env });
  const files = await openEncryptedFiles({
    config,
    master,
    tenantKeys: sources.tenantKeys,
    tenant,
    env,
    clock: systemClock,
    logger,
  });
  try {
    return await work(files.config);
  } finally {
    await files.store?.close?.();
  }
};
