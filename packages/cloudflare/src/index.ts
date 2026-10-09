export type {
  BoundaObjectClass,
  BoundaObjectMethods,
  CreateBoundaObjectArgs,
  CreateBoundaObjectFunction,
} from "./bounda-object.ts";
export { createBoundaObject } from "./bounda-object.ts";
export type { BoundaStub, ConnectFunction, ConnectOptions } from "./client.ts";
export { connect } from "./client.ts";
export type {
  CloudflareDefinition,
  CloudflareFunction,
  CloudflareOptions,
  IsCloudflareDefinitionFunction,
} from "./definition.ts";
export { cloudflare, isCloudflareDefinition } from "./definition.ts";
export type { RpcOutcome, RpcRefusal } from "./outcome.ts";
export type { CreateWorkerArgs, CreateWorkerFunction, TenantOfFunction } from "./worker.ts";
export { createWorker } from "./worker.ts";

declare module "@bounda-dev/core/register" {
  interface Register {
    /**
     * On Cloudflare, port implementations receive the Durable Object's `env` in `create`:
     * the Worker's bindings and variables, as `wrangler types` declares them.
     */
    readonly env: Cloudflare.Env;
  }
}
