import { ConfigurationError } from "@bounda-dev/core";
import type { Config } from "@bounda-dev/core/config";
import type { BoundaStub } from "./client.ts";
import { cloudflareStorageOf } from "./definition.ts";
import { namespaceIn } from "./jurisdiction.ts";

export interface TenantStubArgs {
  /**
   * The app's configuration, with `storage: cloudflare()`.
   */
  readonly config: Config;
  /**
   * The Worker's bindings.
   */
  readonly env: object;
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

export interface BoundaNamespaceArgs {
  readonly config: Config;
  readonly env: object;
}

export interface BoundaNamespaceFunction {
  (args: BoundaNamespaceArgs): DurableObjectNamespace | undefined;
}

// The namespace through the binding and in the jurisdiction `cloudflare()` names, `undefined`
// when the Worker has no such binding: the one way every host reaches a tenant's object.
export const boundaNamespace: BoundaNamespaceFunction = ({ config, env }) => {
  const { binding, jurisdiction } = cloudflareStorageOf(config).options;
  const namespace = Reflect.get(env, binding) as DurableObjectNamespace | undefined;
  return namespace === undefined ? undefined : namespaceIn(namespace, jurisdiction);
};

/**
 * The stub of a tenant's Bounda Durable Object, reached as `createWorker` and the React Router
 * hosts reach it: by the tenant's name, through the binding and in the jurisdiction `cloudflare()`
 * names. Pass it to `connect` from a Worker of your own, so a tenant is never one object in one
 * jurisdiction and another elsewhere. Throws `ConfigurationError` when `storage` is not
 * `cloudflare()` or the Worker has no such binding.
 *
 * @example
 * const store = connect(tenantStub({ config, env, tenant }));
 */
// Asserted, not annotated: an implementation checked against the overload typed by class fails
// with TS2589, its instantiation too deep.
export const tenantStub = (({ config, env, tenant }: TenantStubArgs): unknown => {
  const namespace = boundaNamespace({ config, env });
  if (namespace === undefined) {
    const { binding } = cloudflareStorageOf(config).options;
    throw new ConfigurationError(
      `The Worker has no binding "${binding}": bind the Bounda Durable Object under that name in wrangler.jsonc, or name its binding with cloudflare({ binding })`,
    );
  }
  return namespace.get(namespace.idFromName(tenant));
}) as TenantStubFunction;
