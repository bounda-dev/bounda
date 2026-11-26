import type { StoreSafeguard } from "@bounda-dev/core";
import { ConfigurationError } from "@bounda-dev/core";
import { type ForgetLedger, runtimeText, type TenantKeyStore } from "@bounda-dev/core/adapter";
import {
  defineForgetLedger,
  defineTenantKeyStore,
  type ForgetLedgerDefinition,
  type StoreDefinitionOptions,
  type TenantKeyStoreDefinition,
} from "@bounda-dev/core/config";
import { type CloudflareDefinition, isCloudflareDefinition } from "./definition.ts";
import { isJurisdiction, JURISDICTIONS_LISTED, namespaceIn } from "./jurisdiction.ts";
import { type BoundaKeeperMethods, KEEPER_DIRECTORY, keeperNameOf } from "./keeper.ts";
import { unwrap } from "./outcome.ts";
import { inWorkerRuntime, LEDGER_IN_OBJECT, ROTATE_IN_WORKER } from "./worker-runtime.ts";

/**
 * The binding of the keeper Durable Object that `durableObjectTenantKeys` and
 * `durableObjectForgetLedger` reach when they name none.
 */
export const DEFAULT_KEEPER_BINDING = "KEEPER";

/**
 * Options of `durableObjectTenantKeys` and `durableObjectForgetLedger`.
 */
export type DurableObjectKeeperOptions = {
  /**
   * The app's `storage`, its `cloudflare()`: the keeper lives in the jurisdiction it names, unless
   * `jurisdiction` names another.
   */
  readonly storage: CloudflareDefinition;
  /**
   * The name of the keeper's binding in `wrangler.jsonc`, the class `createBoundaKeeper` returns.
   * Defaults to `DEFAULT_KEEPER_BINDING`.
   */
  readonly binding?: string;
} & (
  | { readonly jurisdiction?: never; readonly safeguard?: never }
  | {
      /**
       * The jurisdiction the keepers are created in and never leave, when not `storage`'s: the
       * store's `location`. Choose it before the first keeper exists, as for `cloudflare()`.
       */
      readonly jurisdiction: DurableObjectJurisdiction;
      /**
       * What allows keeping the store in `jurisdiction`, another than `storage`'s, under articles 45
       * to 47 of the GDPR, which the record of processing and each person's export tell of.
       */
      readonly safeguard?: StoreSafeguard;
    }
);

export interface DurableObjectTenantKeysFunction {
  (options: DurableObjectKeeperOptions): TenantKeyStoreDefinition;
}

export interface DurableObjectForgetLedgerFunction {
  (options: DurableObjectKeeperOptions): ForgetLedgerDefinition;
}

interface KeeperNamespace {
  readonly keeper: (name: string) => BoundaKeeperMethods;
}

const isNamespace = (value: unknown): value is DurableObjectNamespace =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "idFromName") === "function" &&
  typeof Reflect.get(value, "get") === "function";

interface KeeperPlace {
  readonly jurisdiction: DurableObjectJurisdiction | undefined;
  readonly placement: StoreDefinitionOptions;
}

// A Worker's code is not always type-checked.
const placeOf = (options: DurableObjectKeeperOptions, what: string): KeeperPlace => {
  const { storage, safeguard } = options;
  const own: unknown = options.jurisdiction;
  if (!isCloudflareDefinition(storage)) {
    throw runtimeText(
      new ConfigurationError(
        `${what} takes the app's storage, its cloudflare(), whose jurisdiction the keeper shares`,
      ),
    );
  }
  if (own !== undefined && !isJurisdiction(own)) {
    throw runtimeText(
      new ConfigurationError(
        `${what} names a Durable Object jurisdiction, one of ${JURISDICTIONS_LISTED}, not ${JSON.stringify(own)}`,
      ),
    );
  }
  if (own === undefined && safeguard !== undefined) {
    throw runtimeText(
      new ConfigurationError(
        `${what} declares a safeguard and no jurisdiction: a safeguard allows keeping the keepers in another jurisdiction than storage's, so name it beside the safeguard`,
      ),
    );
  }
  const jurisdiction = own ?? storage.options.jurisdiction;
  return {
    jurisdiction,
    placement:
      jurisdiction === undefined
        ? {}
        : safeguard === undefined
          ? { location: jurisdiction }
          : { location: jurisdiction, safeguard },
  };
};

const keepersIn = (
  env: object,
  binding: string,
  jurisdiction: DurableObjectJurisdiction | undefined,
  path: string,
  instead: string,
): KeeperNamespace => {
  if (!inWorkerRuntime()) {
    throw runtimeText(
      new ConfigurationError(
        `${path} is kept in keeper Durable Objects, which only a Worker reaches, and this runs outside one: ${instead}`,
      ),
    );
  }
  const bound: unknown = Reflect.get(env, binding);
  if (!isNamespace(bound)) {
    throw runtimeText(
      new ConfigurationError(
        `${path} names the keeper binding ${binding}, which the Worker's env does not hold: bind the class createBoundaKeeper() returns under durable_objects in wrangler.jsonc`,
      ),
    );
  }
  const namespace = namespaceIn(bound, jurisdiction);
  return {
    keeper: (name) => namespace.get(namespace.idFromName(name)) as unknown as BoundaKeeperMethods,
  };
};

/**
 * A tenant key store in keeper Durable Objects, for `runtime.personalData.tenantKeys` of an app on
 * Cloudflare: each tenant's key, wrapped under the master key, in a keeper object of its own, in
 * the jurisdiction `storage` names, or the one `jurisdiction` names under a `safeguard`, outside
 * the tenant's object, so neither a restore of that
 * object nor a copy of it brings back the key of a tenant `forgetTenant` destroyed. Its writes
 * compare the revision and set the record at once. A binding missing from the object's `env`
 * fails its start with `ConfigurationError`, and so does a `storage` that is not `cloudflare()`,
 * or opening it outside a Worker, as `bounda tenant-key rewrap-master` would from a terminal.
 */
export const durableObjectTenantKeys: DurableObjectTenantKeysFunction = (options) => {
  const { binding = DEFAULT_KEEPER_BINDING } = options;
  const { jurisdiction, placement } = placeOf(options, "durableObjectTenantKeys()");
  return defineTenantKeyStore(({ env }): TenantKeyStore => {
    const { keeper } = keepersIn(
      env,
      binding,
      jurisdiction,
      "runtime.personalData.tenantKeys",
      ROTATE_IN_WORKER,
    );
    const directory = keeper(KEEPER_DIRECTORY);
    // An object reads and writes its own tenant's record alone; the schedule goes through many.
    const keepers = new Map<string, BoundaKeeperMethods>();
    const keeperOf = (tenant: string): BoundaKeeperMethods => {
      const found = keepers.get(tenant) ?? keeper(keeperNameOf(tenant));
      keepers.set(tenant, found);
      return found;
    };
    return {
      get: (tenant) => unwrap(keeperOf(tenant).getTenantKeys(tenant)),
      put: async (tenant, record, expected) => {
        // Listed before its first record exists, so a rotation of the master key finds every
        // tenant with one.
        if (expected === null) await unwrap(directory.registerTenant(tenant));
        return unwrap(keeperOf(tenant).putTenantKeys(tenant, record, expected));
      },
      remove: async (tenant, expected) => {
        if (!(await unwrap(keeperOf(tenant).removeTenantKeys(tenant, expected)))) return false;
        // The record is gone either way, and a tenant listed without one reads as none.
        await unwrap(directory.unregisterTenant(tenant)).catch(() => undefined);
        return true;
      },
      list: (args) => unwrap(directory.listTenants(args)),
    };
  }, placement);
};

/**
 * A forget ledger in keeper Durable Objects, for `runtime.personalData.forgetLedger.store` of an
 * app on Cloudflare: each tenant's entries in its keeper object, in the jurisdiction `storage`
 * names, or the one `jurisdiction` names under a `safeguard`, outside the tenant's object, so restoring that object to an earlier time leaves the
 * ledger whole. Its reads see every write at once, and with `keepFor` the keeper removes each
 * entry once past it on its own alarm, whether the tenant's object is awake or not. A binding
 * missing from the object's `env` fails its start with `ConfigurationError`, and so does a
 * `storage` that is not `cloudflare()`, or opening it outside a Worker.
 */
export const durableObjectForgetLedger: DurableObjectForgetLedgerFunction = (options) => {
  const { binding = DEFAULT_KEEPER_BINDING } = options;
  const { jurisdiction, placement } = placeOf(options, "durableObjectForgetLedger()");
  return defineForgetLedger(({ env, tenant, keepForMs }): ForgetLedger => {
    const { keeper } = keepersIn(
      env,
      binding,
      jurisdiction,
      "runtime.personalData.forgetLedger.store",
      LEDGER_IN_OBJECT,
    );
    const own = keeper(keeperNameOf(tenant));
    // The keeper is told how long to keep the entries before the first call, and again after a
    // call that failed before it was.
    let retained: Promise<unknown> | undefined;
    const retain = (): Promise<unknown> => {
      retained ??= unwrap(own.retainLedger(tenant, keepForMs ?? null)).catch((error: unknown) => {
        retained = undefined;
        throw error;
      });
      return retained;
    };
    return {
      append: async (entries) => {
        await retain();
        await unwrap(own.appendLedger(tenant, entries));
      },
      read: async (args) => {
        await retain();
        return unwrap(own.readLedger(tenant, args));
      },
      prune: async (args) => {
        await retain();
        await unwrap(own.pruneLedger(tenant, args));
      },
      readMark: async (name) => {
        await retain();
        return unwrap(own.readLedgerMark(tenant, name));
      },
      raiseMark: async (name, mark) => {
        await retain();
        await unwrap(own.raiseLedgerMark(tenant, name, mark));
      },
      clear: async () => {
        await retain();
        await unwrap(own.clearLedger(tenant));
        return true;
      },
      fence: {
        read: async () => {
          await retain();
          return unwrap(own.readLedgerFence(tenant));
        },
        set: async (fence) => {
          await retain();
          return unwrap(own.fenceLedger(tenant, fence));
        },
      },
    };
  }, placement);
};
