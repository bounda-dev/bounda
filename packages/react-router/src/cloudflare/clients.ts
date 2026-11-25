import {
  type BoundaStub,
  boundaNamespace,
  connect,
  isCloudflareDefinition,
} from "@bounda-dev/cloudflare";
import {
  type BoundaClient,
  ConfigurationError,
  type Consistency,
  type Registry,
} from "@bounda-dev/core";
import type { Config } from "@bounda-dev/core/config";
import type { RequestArgs } from "../actor.ts";
import type { RefuseRequestFunction } from "../host-log.ts";
import { type TenantFunction, tenantOfRequest } from "../tenant.ts";

export type { TenantFunction } from "../tenant.ts";

export interface CloudflareClientsArgs {
  readonly env: object;
  readonly config: Config;
  readonly tenant: TenantFunction;
  readonly consistency: Consistency;
}

/**
 * The client of a request; `refuse` records in the host log a request whose tenant `tenant` does
 * not name.
 */
export interface ClientOfFunction<R extends Registry> {
  (args: RequestArgs, refuse: RefuseRequestFunction): BoundaClient<R>;
}

export interface CloudflareClientsFunction {
  <R extends Registry>(args: CloudflareClientsArgs): ClientOfFunction<R>;
}

const lazyStub = (stubOf: () => Promise<BoundaStub>): BoundaStub => ({
  command: async (...args) => (await stubOf()).command(...args),
  query: async (...args) => (await stubOf()).query(...args),
  lag: async () => (await stubOf()).lag(),
  status: async () => (await stubOf()).status(),
  listSubscriberFailures: async (...args) => (await stubOf()).listSubscriberFailures(...args),
  getSubscriberFailure: async (...args) => (await stubOf()).getSubscriberFailure(...args),
  readEvents: async (args) => (await stubOf()).readEvents(args),
  listDeadLetters: async (...args) => (await stubOf()).listDeadLetters(...args),
  retryDeadLetter: async (...args) => (await stubOf()).retryDeadLetter(...args),
  discardDeadLetter: async (...args) => (await stubOf()).discardDeadLetter(...args),
  rebuildReadModel: async (name) => (await stubOf()).rebuildReadModel(name),
  forget: async (...args) => (await stubOf()).forget(...args),
  exportPersonalData: async (...args) => (await stubOf()).exportPersonalData(...args),
  streamPersonalData: async (...args) => (await stubOf()).streamPersonalData(...args),
  recipientsOf: async (...args) => (await stubOf()).recipientsOf(...args),
  restrict: async (...args) => (await stubOf()).restrict(...args),
  unrestrict: async (...args) => (await stubOf()).unrestrict(...args),
  redact: async (...args) => (await stubOf()).redact(...args),
  forgetTenant: async (...args) => (await stubOf()).forgetTenant(...args),
  exportTenant: async (...args) => (await stubOf()).exportTenant(...args),
  freezeTenant: async (...args) => (await stubOf()).freezeTenant(...args),
  unfreezeTenant: async (...args) => (await stubOf()).unfreezeTenant(...args),
  rotateTenantKey: async (...args) => (await stubOf()).rotateTenantKey(...args),
  retireTenantKeys: async (...args) => (await stubOf()).retireTenantKeys(...args),
});

export const cloudflareClients: CloudflareClientsFunction = <R extends Registry>({
  env,
  config,
  tenant,
  consistency,
}: CloudflareClientsArgs): ClientOfFunction<R> => {
  if (!isCloudflareDefinition(config.storage)) {
    throw new ConfigurationError(
      "React Router on Cloudflare serves an app that runs in a Durable Object: set storage to cloudflare() in bounda.config.ts",
    );
  }
  const namespace = boundaNamespace({ config, env });
  if (typeof tenant !== "function") {
    throw new ConfigurationError(
      'tenant must be a function that names the store of a request, such as () => "default"',
    );
  }
  return (args, refuse) => {
    let stub: Promise<BoundaStub> | undefined;
    const stubOf = (): Promise<BoundaStub> => {
      stub ??= tenantOfRequest(tenant, args).then(
        (name) => namespace.get(namespace.idFromName(name)) as unknown as BoundaStub,
        async (error: unknown) => {
          await refuse(args, "tenant-unresolved");
          throw error;
        },
      );
      return stub;
    };
    return connect<R>(lazyStub(stubOf), { consistency });
  };
};
