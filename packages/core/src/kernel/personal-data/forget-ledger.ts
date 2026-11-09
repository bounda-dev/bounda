import type { Adapter } from "../../adapter/adapter.ts";
import type { AdapterDefinition } from "../../adapter/adapter-definition.ts";
import type { ForgetLedger } from "../../adapter/storage/forget-ledger.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConfigurationError, ForgetLedgerTimeoutError } from "../../contracts/errors.ts";
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
  /**
   * How long the app keeps each entry after its `forgottenAt`, from `keepFor`; `undefined` keeps
   * entries for good. Only a ledger without `prune` uses it, to expire its entries itself.
   */
  readonly keepForMs?: number | undefined;
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
 * What `runtime.personalData.forgetLedger.store` holds: an adapter pointed at another database
 * than the storage, whose ledger table it creates there, or a ledger definition.
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
  keepForMs,
}) => {
  if (source === null) return null;
  if (source.kind === "bounda-adapter" && sharesStorage(source, storage)) {
    throw new ConfigurationError(
      "runtime.personalData.forgetLedger.store points at the storage's own database, which a restore rolls back with it: give it another database",
    );
  }
  return source.kind === "bounda-forget-ledger"
    ? source.create({ env, tenant, keepForMs })
    : source.createForgetLedger({ tenant, keepForMs });
};

export interface BoundedForgetLedger extends ForgetLedger {
  /**
   * Whether a call given up for its timeout has not settled yet.
   */
  late(): boolean;
}

export interface BoundForgetLedgerArgs {
  readonly ledger: ForgetLedger;
  readonly timeoutMs: number;
  readonly clock: Clock;
}

export interface BoundForgetLedgerFunction {
  (args: BoundForgetLedgerArgs): BoundedForgetLedger;
}

/**
 * The ledger whose calls reject with `ForgetLedgerTimeoutError` once `timeoutMs` passes without
 * them settling. A call given up that way goes on behind, and may still land.
 */
export const boundForgetLedger: BoundForgetLedgerFunction = ({ ledger, timeoutMs, clock }) => {
  let late = 0;
  const bound = async <T>(operation: string, call: () => Promise<T>): Promise<T> => {
    const work = call();
    let cancel: () => void = () => undefined;
    const timeout = new Promise<never>((_, reject) => {
      cancel = clock.after(timeoutMs, () => {
        late += 1;
        const settle = (): void => {
          late -= 1;
        };
        work.then(settle, settle);
        reject(new ForgetLedgerTimeoutError(operation, timeoutMs));
      });
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      cancel();
    }
  };
  const { prune, close } = ledger;
  return {
    append: (entries) => bound("append", () => ledger.append(entries)),
    read: (args) => bound("read", () => ledger.read(args)),
    ...(ledger.visibilityDelayMs === undefined
      ? {}
      : { visibilityDelayMs: ledger.visibilityDelayMs }),
    ...(prune === undefined
      ? {}
      : { prune: (args) => bound("prune", () => prune.call(ledger, args)) }),
    ...(close === undefined ? {} : { close: () => close.call(ledger) }),
    late: () => late > 0,
  };
};

export interface WaitForLedgerFunction {
  <T>(clock: Clock, timeoutMs: number, work: Promise<T>): Promise<T | "late">;
}

/**
 * `work`, or `"late"` once `timeoutMs` has passed without it settling.
 */
export const waitForLedger: WaitForLedgerFunction = async (clock, timeoutMs, work) => {
  let cancel: () => void = () => undefined;
  const late = new Promise<"late">((resolve) => {
    cancel = clock.after(timeoutMs, () => resolve("late"));
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    cancel();
  }
};
