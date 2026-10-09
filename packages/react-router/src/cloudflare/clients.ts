import { type BoundaStub, connect, isCloudflareDefinition } from "@bounda-dev/adapter-cloudflare";
import {
  type BoundaClient,
  ConfigurationError,
  type Consistency,
  type Registry,
} from "@bounda-dev/core";
import type { Config } from "@bounda-dev/core/config";
import type { MiddlewareFunction } from "react-router";

/**
 * What a middleware receives: the request, its route's params and its context.
 */
export type RequestArgs = Parameters<MiddlewareFunction>[0];

/**
 * Names the store a request reaches: every tenant is its own Durable Object, with its own events
 * and read models. Called the first time a request uses `bounda`, and once per request.
 */
export interface TenantFunction {
  (args: RequestArgs): string | Promise<string>;
}

export interface CloudflareClientsArgs {
  readonly env: object;
  readonly config: Config;
  readonly tenant: TenantFunction;
  readonly consistency: Consistency;
}

export interface ClientOfFunction<R extends Registry> {
  (args: RequestArgs): BoundaClient<R>;
}

export interface CloudflareClientsFunction {
  <R extends Registry>(args: CloudflareClientsArgs): ClientOfFunction<R>;
}

interface StoreNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): BoundaStub;
}

const lazyStub = (stubOf: () => Promise<BoundaStub>): BoundaStub => ({
  command: async (...args) => (await stubOf()).command(...args),
  query: async (...args) => (await stubOf()).query(...args),
  lag: async () => (await stubOf()).lag(),
  listDeadLetters: async (...args) => (await stubOf()).listDeadLetters(...args),
  retryDeadLetter: async (id) => (await stubOf()).retryDeadLetter(id),
  discardDeadLetter: async (id) => (await stubOf()).discardDeadLetter(id),
  rebuildReadModel: async (name) => (await stubOf()).rebuildReadModel(name),
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
  const { binding } = config.storage.options;
  const namespace = Reflect.get(env, binding) as StoreNamespace | undefined;
  if (namespace === undefined) {
    throw new ConfigurationError(
      `The Worker has no binding "${binding}": bind the Bounda Durable Object under that name in wrangler.jsonc, or name its binding with cloudflare({ binding })`,
    );
  }
  if (typeof tenant !== "function") {
    throw new ConfigurationError(
      'tenant must be a function that names the store of a request, such as () => "default"',
    );
  }
  return (args) => {
    let stub: Promise<BoundaStub> | undefined;
    const stubOf = (): Promise<BoundaStub> => {
      stub ??= Promise.resolve()
        .then(() => tenant(args))
        .then((name) => {
          if (typeof name !== "string") {
            throw new ConfigurationError(
              `tenant must name the store of a request with a string, got ${JSON.stringify(name)}`,
            );
          }
          return namespace.get(namespace.idFromName(name));
        });
      return stub;
    };
    return connect<R>(lazyStub(stubOf), { consistency });
  };
};
