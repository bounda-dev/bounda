import type { Adapter, Storage } from "../../adapter/adapter.ts";
import type { TenantKeyStore } from "../../adapter/storage/tenant-key-store.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { AppEnv } from "../../register/index.ts";
import { runtimeText } from "../shared/runtime-text.ts";
import type { CryptoKeyWrapper, KeyWrapperDefinition } from "./key-wrapper.ts";
import { openTenantKeyStore, type TenantKeySource } from "./tenant-key-source.ts";
import { openTenantKeys, type TenantKeys } from "./tenant-keys.ts";
import { createPersonalKeyWrapping, type PersonalKeyWrapping } from "./wrapped-keys.ts";

/**
 * Every key an app holds above its database: the master key, the tenant's key and the store it
 * lives in, and the persons' keys as the kernel seals and opens with them.
 */
export interface KeyHierarchy {
  readonly master: CryptoKeyWrapper;
  readonly tenantKeys: TenantKeys;
  readonly wrapping: PersonalKeyWrapping;
  close(): Promise<void>;
}

export interface KeySources {
  readonly keyWrapper: KeyWrapperDefinition | null;
  readonly tenantKeys: TenantKeySource | null;
  /**
   * Whether the tenant key store is the storage's own, gone with the process as its database is.
   */
  readonly ephemeral?: boolean;
}

export interface KeySourcesOfArgs {
  readonly storage: Adapter;
  readonly personalData: KeySources;
}

export interface KeySourcesOfFunction {
  (args: KeySourcesOfArgs): KeySources;
}

/**
 * The master key and the tenant key store the configuration names, or the storage's own where it
 * names none and the storage brings them, as `memory()` does. A master key gone with the process
 * wraps nothing a store that outlives it keeps, so it is never paired with one the configuration
 * names.
 */
export const keySourcesOf: KeySourcesOfFunction = ({ storage, personalData }) => {
  const ephemeral = storage.ephemeralKeys;
  return {
    keyWrapper:
      personalData.keyWrapper ??
      (personalData.tenantKeys === null ? (ephemeral?.keyWrapper ?? null) : null),
    tenantKeys: personalData.tenantKeys ?? ephemeral?.tenantKeys ?? null,
    ephemeral: personalData.tenantKeys === null && ephemeral !== undefined,
  };
};

export interface OpenKeyHierarchyArgs {
  readonly storage: Adapter;
  /**
   * Built from `keySourcesOf`'s `keyWrapper` before anything opens, `null` without one.
   */
  readonly master: CryptoKeyWrapper | null;
  readonly tenantKeys: TenantKeySource | null;
  /**
   * Whether `tenantKeys` is the storage's own, as `keySourcesOf` says.
   */
  readonly ephemeral?: boolean;
  readonly opened: Pick<Storage, "tenancy" | "personalKeys" | "indexKeys">;
  /**
   * The tenant key store `openEncryptedFiles` opened already, closed with the hierarchy.
   */
  readonly store?: TenantKeyStore | null;
  /**
   * Whether the storage's database is the record's own, as `openEncryptedFiles` says.
   */
  readonly claims?: boolean;
  readonly tenant: string;
  /**
   * Whether the registry marks a field personal, anywhere: the keys are then required.
   */
  readonly personal: boolean;
  readonly env: AppEnv;
  readonly clock: Clock;
}

export interface OpenKeyHierarchyFunction {
  (args: OpenKeyHierarchyArgs): Promise<KeyHierarchy | null>;
}

/**
 * Opens the tenant's keys under the master key; `null` for an app that marks nothing personal and
 * names no keys. Refuses an app that marks personal fields without a master key and a tenant key
 * store, and one that names only one of them.
 */
export const openKeyHierarchy: OpenKeyHierarchyFunction = async ({
  storage,
  master,
  tenantKeys,
  ephemeral = false,
  opened,
  store: given = null,
  claims = false,
  tenant,
  personal,
  env,
  clock,
}) => {
  if (master === null && tenantKeys === null && !personal) return null;
  // Closed whatever is refused below: the hierarchy owns it.
  const closeGiven = async (): Promise<void> => {
    await given?.close?.().catch(() => undefined);
  };
  if (master === null) {
    await closeGiven();
    throw runtimeText(
      new ConfigurationError(
        personal
          ? 'The registry marks personal fields, so runtime.personalData.keyWrapper must wrap their keys: set masterKey({ from: "BOUNDA_MASTER_KEY" }) or a wrapper from defineKeyWrapper'
          : 'runtime.personalData.tenantKeys needs runtime.personalData.keyWrapper, which wraps the tenant\'s key: set masterKey({ from: "BOUNDA_MASTER_KEY" }) or a wrapper from defineKeyWrapper',
      ),
    );
  }
  if (tenantKeys === null) {
    await closeGiven();
    throw runtimeText(
      new ConfigurationError(
        "runtime.personalData.tenantKeys must name where the tenant's key lives, apart from the storage's database: such as sqlite({ path: \"./keys/tenant-keys.db\" }), or kvTenantKeys({ binding }) on Cloudflare",
      ),
    );
  }
  const store: TenantKeyStore =
    given ?? (await openTenantKeyStore({ source: tenantKeys, storage, env }));
  try {
    const keys = await openTenantKeys({
      tenant,
      store,
      tenancy: opened.tenancy,
      master,
      clock,
      ephemeral,
      claims,
      holdsTenantWrapped: async (legacy) => {
        const outside = (kid: string | null): boolean => kid !== null && !legacy.includes(kid);
        if ((await opened.personalKeys.kids()).some(outside)) return true;
        const indexKey = await opened.indexKeys.get();
        return indexKey !== null && outside(indexKey.kid);
      },
    });
    const wrapping = createPersonalKeyWrapping({ tenantKeys: keys, master, clock });
    return {
      master,
      tenantKeys: keys,
      wrapping,
      close: async () => {
        wrapping.close();
        keys.close();
        await store.close?.();
      },
    };
  } catch (error) {
    await store.close?.().catch(() => undefined);
    throw error;
  }
};
