export type { DurableObjectAdapterArgs, DurableObjectAdapterFunction } from "./adapter.ts";
export { durableObjectAdapter } from "./adapter.ts";
export type {
  BoundaObjectClass,
  BoundaObjectMethods,
  CreateBoundaObjectArgs,
  CreateBoundaObjectFunction,
} from "./bounda-object.ts";
export { createBoundaObject } from "./bounda-object.ts";
export type { BoundaStub, ConnectFunction, ConnectOptions, RedactRequest } from "./client.ts";
export { connect } from "./client.ts";
export type {
  CloudflareDefinition,
  CloudflareFunction,
  CloudflareOptions,
  IsCloudflareDefinitionFunction,
} from "./definition.ts";
export { cloudflare, isCloudflareDefinition } from "./definition.ts";
export type {
  ExpireKvForgetLedgerArgs,
  ExpireKvForgetLedgerFunction,
  KvForgetLedgerExpiry,
  KvForgetLedgerFunction,
  KvForgetLedgerOptions,
  KvLedgerKey,
  KvLedgerPut,
  PlanKvForgetLedgerExpiryArgs,
  PlanKvForgetLedgerExpiryFunction,
} from "./forget-ledger.ts";
export {
  expireKvForgetLedger,
  KV_FORGET_LEDGER_ROOT,
  KV_LIST_DELAY_MS,
  kvForgetLedger,
  planKvForgetLedgerExpiry,
} from "./forget-ledger.ts";
export { workersLogger } from "./logger.ts";
export type { RpcOutcome, RpcRefusal } from "./outcome.ts";
export type { DurableSqlStorage } from "./sql-database.ts";
export type {
  ActorOfFunction,
  CreateWorkerArgs,
  CreateWorkerFunction,
  TenantOfFunction,
} from "./worker.ts";
export { createWorker, DEFAULT_MAX_PAYLOAD_BYTES } from "./worker.ts";

declare module "@bounda-dev/core/register" {
  interface Register {
    /**
     * On Cloudflare, port implementations receive the Durable Object's `env` in `create`:
     * the Worker's bindings and variables, as `wrangler types` declares them.
     */
    readonly env: Cloudflare.Env;
  }
}
