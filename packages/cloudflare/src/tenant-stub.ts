import { ConfigurationError } from "@bounda-dev/core";
import type { Config } from "@bounda-dev/core/config";
import type { BoundaStub } from "./client.ts";
import { cloudflareStorageOf } from "./definition.ts";
import { namespaceIn } from "./jurisdiction.ts";

export interface BoundaNamespaceArgs {
  /**
   * The app's configuration, with `storage: cloudflare()`.
   */
  readonly config: Config;
  /**
   * The Worker's bindings.
   */
  readonly env: object;
}

export interface FindBoundaNamespaceFunction {
  (args: BoundaNamespaceArgs): DurableObjectNamespace | undefined;
}

// `boundaNamespace` without its refusal, for a host that answers a missing binding itself.
export const findBoundaNamespace: FindBoundaNamespaceFunction = ({ config, env }) => {
  const { binding, jurisdiction } = cloudflareStorageOf(config).options;
  const namespace = Reflect.get(env, binding) as DurableObjectNamespace | undefined;
  return namespace === undefined ? undefined : namespaceIn(namespace, jurisdiction);
};

export interface BoundaNamespaceFunction {
  <T extends Rpc.DurableObjectBranded | undefined = undefined>(
    args: BoundaNamespaceArgs,
  ): DurableObjectNamespace<T>;
}

/**
 * The namespace of the Bounda Durable Object, through the binding and in the jurisdiction
 * `cloudflare()` names: every id it gives is of an object in that jurisdiction. Resolve it once
 * where the Worker starts, rather than on every request. Throws `ConfigurationError` when
 * `storage` is not `cloudflare()`, when a read model on `cloudflare()` names another jurisdiction,
 * or when the Worker has no such binding.
 */
export const boundaNamespace = ((args: BoundaNamespaceArgs): DurableObjectNamespace => {
  const namespace = findBoundaNamespace(args);
  if (namespace === undefined) {
    const { binding } = cloudflareStorageOf(args.config).options;
    throw new ConfigurationError(
      `The Worker has no binding "${binding}": bind the Bounda Durable Object under that name in wrangler.jsonc, or name its binding with cloudflare({ binding })`,
    );
  }
  return namespace;
}) as BoundaNamespaceFunction;

export interface TenantStubArgs extends BoundaNamespaceArgs {
  /**
   * The name the tenant's object is addressed by.
   */
  readonly tenant: string;
}

export interface TenantStubFunction {
  (args: TenantStubArgs): DurableObjectStub & BoundaStub;
  /**
   * Typed as the object's class, so a test reaches the object with `runInDurableObject`.
   */
  <T extends Rpc.DurableObjectBranded>(args: TenantStubArgs): DurableObjectStub<T>;
}

/**
 * The stub of a tenant's Bounda Durable Object, reached as `createWorker` and the React Router
 * hosts reach it: by the tenant's name, through `boundaNamespace`. Pass it to `connect` from a
 * Worker of your own, so a tenant is never one object in one jurisdiction and another elsewhere.
 * Throws as `boundaNamespace` does.
 *
 * @example
 * const store = connect(tenantStub({ config, env, tenant }));
 */
// Asserted, not annotated: an implementation checked against the overload typed by class fails
// with TS2589, its instantiation too deep.
export const tenantStub = (({ tenant, ...args }: TenantStubArgs): unknown => {
  const namespace = boundaNamespace(args);
  return namespace.get(namespace.idFromName(tenant));
}) as TenantStubFunction;
