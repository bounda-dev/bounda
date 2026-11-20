import { ConfigurationError } from "@bounda-dev/core";
import { type ForgetLedger, runtimeText, type TenantKeyStore } from "@bounda-dev/core/adapter";
import {
  defineForgetLedger,
  defineTenantKeyStore,
  type ForgetLedgerDefinition,
  type TenantKeyStoreDefinition,
} from "@bounda-dev/core/config";
import { type CloudflareDefinition, isCloudflareDefinition } from "./definition.ts";
import { namespaceIn } from "./jurisdiction.ts";
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
export interface DurableObjectKeeperOptions {
  /**
   * The app's `storage`, its `cloudflare()`: the keeper lives in the jurisdiction it names.
   */
  readonly storage: CloudflareDefinition;
  /**
   * The name of the keeper's binding in `wrangler.jsonc`, the class `createBoundaKeeper` returns.
   * Defaults to `DEFAULT_KEEPER_BINDING`.
   */
  readonly binding?: string;
}

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

// A Worker's code is not always type-checked.
const jurisdictionOf = (storage: unknown, what: string): DurableObjectJurisdiction | undefined => {
  if (!isCloudflareDefinition(storage)) {
    throw runtimeText(
      new ConfigurationError(
        `${what} takes the app's storage, its cloudflare(), whose jurisdiction the keeper shares`,
      ),
    );
  }
  return storage.options.jurisdiction;
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

const locationOf = (storage: CloudflareDefinition) =>
  storage.location === undefined ? {} : { location: storage.location };

/**
 * A tenant key store in keeper Durable Objects, for `runtime.personalData.tenantKeys` of an app on
 * Cloudflare: each tenant's key, wrapped under the master key, in a keeper object of its own, in
 * the jurisdiction `storage` names, outside the tenant's object, so neither a restore of that
 * object nor a copy of it brings back the key of a tenant `forgetTenant` destroyed. Its writes
 * compare the revision and set the record at once. A binding missing from the object's `env`
 * fails its start with `ConfigurationError`, and so does a `storage` that is not `cloudflare()`.
 */
export const durableObjectTenantKeys: DurableObjectTenantKeysFunction = ({
  storage,
  binding = DEFAULT_KEEPER_BINDING,
}) => {
  const jurisdiction = jurisdictionOf(storage, "durableObjectTenantKeys()");
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
      list: (args) => unwrap(directory.listTenants(args)),
    };
  }, locationOf(storage));
};

/**
 * A forget ledger in keeper Durable Objects, for `runtime.personalData.forgetLedger.store` of an
 * app on Cloudflare: each tenant's entries in its keeper object, in the jurisdiction `storage`
 * names, outside the tenant's object, so restoring that object to an earlier time leaves the
 * ledger whole. Its reads see every write at once, and with `keepFor` the keeper removes each
 * entry once past it on its own alarm, whether the tenant's object is awake or not. A binding
 * missing from the object's `env` fails its start with `ConfigurationError`, and so does a
 * `storage` that is not `cloudflare()`.
 */
export const durableObjectForgetLedger: DurableObjectForgetLedgerFunction = ({
  storage,
  binding = DEFAULT_KEEPER_BINDING,
}) => {
  const jurisdiction = jurisdictionOf(storage, "durableObjectForgetLedger()");
  return defineForgetLedger(({ env, tenant, keepForMs }): ForgetLedger => {
    const { keeper } = keepersIn(
      env,
      binding,
      jurisdiction,
      "runtime.personalData.forgetLedger.store",
      LEDGER_IN_OBJECT,
    );
    if (tenant === undefined) {
      throw runtimeText(
        new ConfigurationError(
          "A keeper forget ledger keeps each tenant's entries in the tenant's own keeper, and this app names no tenant: run it in a Bounda Durable Object, or give createApp a tenant",
        ),
      );
    }
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
      raiseMark: async (name, value) => {
        await retain();
        await unwrap(own.raiseLedgerMark(tenant, name, value));
      },
    };
  }, locationOf(storage));
};
