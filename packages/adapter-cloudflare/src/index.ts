export type { DurableObjectAdapterArgs, DurableObjectAdapterFunction } from "./adapter.ts";
export { durableObjectAdapter } from "./adapter.ts";
export type {
  BoundaObjectClass,
  BoundaObjectMethods,
  CreateBoundaObjectArgs,
  CreateBoundaObjectFunction,
} from "./bounda-object.ts";
export { createBoundaObject } from "./bounda-object.ts";
export type { BoundaClient, BoundaStub, ConnectFunction } from "./client.ts";
export { connect } from "./client.ts";
export type {
  CloudflareDefinition,
  CloudflareFunction,
  CloudflareOptions,
  IsCloudflareDefinitionFunction,
} from "./definition.ts";
export { cloudflare, DEFAULT_TABLE_PREFIX, isCloudflareDefinition } from "./definition.ts";
export { workersLogger } from "./logger.ts";
export type { RpcOutcome, RpcRefusal } from "./outcome.ts";
export type { CreateDurableSqlDatabaseFunction, DurableSqlStorage } from "./sql-database.ts";
export { createDurableSqlDatabase } from "./sql-database.ts";
export type { NextWakeArgs, NextWakeFunction } from "./wake.ts";
export { nextWake } from "./wake.ts";
export type { CreateWorkerArgs, CreateWorkerFunction, TenantOfFunction } from "./worker.ts";
export { createWorker, TENANT_HEADER } from "./worker.ts";

declare module "@bounda-dev/core/register" {
  interface Register {
    /**
     * On Cloudflare, collaborator implementations receive the Durable Object's `env` in `create`:
     * the Worker's bindings and variables, as `wrangler types` declares them.
     */
    readonly env: Cloudflare.Env;
  }
}
