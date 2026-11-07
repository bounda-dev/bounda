import type { Adapter } from "../../adapter/adapter.ts";
import type { AdapterDefinition } from "../../adapter/adapter-definition.ts";
import type { ForgetLedger } from "../../adapter/storage/forget-ledger.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { AppEnv } from "../../register/index.ts";

export interface CreateForgetLedgerFromEnvArgs {
  /**
   * The host's environment, as port implementations receive it: `process.env` in Node, the
   * Worker's bindings in a Durable Object.
   */
  readonly env: AppEnv;
  /**
   * The name of the store the app serves, whose entries the ledger keeps apart.
   */
  readonly tenant?: string | undefined;
}

/**
 * A forget ledger built from the host's environment when the app starts, by `defineForgetLedger`
 * or a host package, such as `kvForgetLedger` from `@bounda-dev/cloudflare`.
 */
export interface ForgetLedgerDefinition {
  readonly kind: "bounda-forget-ledger";
  create(args: CreateForgetLedgerFromEnvArgs): ForgetLedger | Promise<ForgetLedger>;
}

/**
 * What `runtime.personalData.forgetLedger` holds: an adapter pointed at another database than the
 * storage, whose ledger table it creates there, or a ledger definition.
 */
export type ForgetLedgerSource = Adapter | ForgetLedgerDefinition;

export interface DefineForgetLedgerFunction {
  (create: ForgetLedgerDefinition["create"]): ForgetLedgerDefinition;
}

/**
 * A forget ledger of your own, built from the host's environment when the app starts. A `create`
 * that throws fails the start, so it should only read its settings and open what it needs
 * lazily: the ledger's own calls may fail, and the runtime tries them again.
 */
export const defineForgetLedger: DefineForgetLedgerFunction = (create) => ({
  kind: "bounda-forget-ledger",
  create,
});

export interface IsForgetLedgerSourceFunction {
  (value: unknown): value is ForgetLedgerSource;
}

export const isForgetLedgerSource: IsForgetLedgerSourceFunction = (
  value,
): value is ForgetLedgerSource => {
  if (typeof value !== "object" || value === null) return false;
  const kind = Reflect.get(value, "kind");
  if (kind === "bounda-forget-ledger") return typeof Reflect.get(value, "create") === "function";
  return (
    kind === "bounda-adapter" && typeof Reflect.get(value, "createForgetLedger") === "function"
  );
};

export interface OpenForgetLedgerArgs extends CreateForgetLedgerFromEnvArgs {
  readonly source: ForgetLedgerSource | null;
  readonly storage: AdapterDefinition;
}

export interface OpenForgetLedgerFunction {
  (args: OpenForgetLedgerArgs): Promise<ForgetLedger | null>;
}

// The same adapter, or one of the same kind with the same options: a database a restore rolls back
// together with the storage. Two memory adapters are two stores whatever their options.
const sharesStorage = (source: Adapter, storage: AdapterDefinition): boolean =>
  source === storage ||
  (source.name !== "memory" &&
    source.name === storage.name &&
    JSON.stringify(source.options) === JSON.stringify(storage.options));

/**
 * Refuses a ledger adapter that points at the storage's own database.
 */
export const openForgetLedger: OpenForgetLedgerFunction = async ({
  source,
  storage,
  env,
  tenant,
}) => {
  if (source === null) return null;
  if (source.kind === "bounda-adapter" && sharesStorage(source, storage)) {
    throw new ConfigurationError(
      "runtime.personalData.forgetLedger points at the storage's own database, which a restore rolls back with it: give it another database",
    );
  }
  return source.kind === "bounda-forget-ledger"
    ? source.create({ env, tenant })
    : source.createForgetLedger({ tenant });
};
