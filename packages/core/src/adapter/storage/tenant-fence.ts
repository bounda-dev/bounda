import { TenantForgottenError, TenantFrozenError } from "../../contracts/errors.ts";

/**
 * Whether a database takes the writes of its tenant: `open`, `frozen` by `freezeTenant` until
 * `unfreezeTenant`, or `forgotten` by `forgetTenant`, for good.
 */
export type TenantFenceState = "open" | "frozen" | "forgotten";

/**
 * The fence a database holds: its state, and, unless it is open, whose tenant it fences and since
 * when, as an ISO timestamp.
 */
export type TenantFence =
  | { readonly state: "open" }
  | {
      readonly state: "frozen" | "forgotten";
      readonly tenant: string;
      readonly since: string;
    };

/**
 * The fence of one database, which every write to it checks in its own transaction, so a write
 * from any instance, however stale what it knows of the tenant, either commits before the fence is
 * raised or is refused after: with `TenantFrozenError` under `frozen`, `TenantForgottenError` under
 * `forgotten`, and nothing of it kept. Reads go through whatever it says.
 */
export interface TenantFenceStore {
  /**
   * The fence as the database holds it now: `open` for one never fenced.
   */
  read(): Promise<TenantFence>;
  /**
   * Raises or lowers the fence once every write under way has committed or rolled back, and
   * resolves to the fence as it then stands. `forgotten` is final: nothing set over it changes it.
   * `frozen` over `frozen` keeps the first `since`.
   */
  set(fence: TenantFence): Promise<TenantFence>;
}

export interface FenceErrorFunction {
  (
    fence: Exclude<TenantFence, { readonly state: "open" }>,
  ): TenantFrozenError | TenantForgottenError;
}

/**
 * What a write a fence refuses rejects with.
 */
export const fenceError: FenceErrorFunction = (fence) =>
  fence.state === "frozen"
    ? new TenantFrozenError(fence.tenant, fence.since)
    : new TenantForgottenError(fence.tenant, fence.since);

export interface NextFenceFunction {
  (current: TenantFence, asked: TenantFence): TenantFence;
}

/**
 * The fence `set` leaves: the one asked for, but `forgotten` once it is, and the first `since` of
 * a state set again.
 */
export const nextFence: NextFenceFunction = (current, asked) => {
  if (current.state === "forgotten") return current;
  if (current.state === asked.state) return current;
  return asked;
};

export interface IsFenceErrorFunction {
  (error: unknown): error is TenantFrozenError | TenantForgottenError;
}

/**
 * Whether a write failed on a fence: the tenant is frozen or forgotten, nothing else went wrong.
 */
export const isFenceError: IsFenceErrorFunction = (
  error,
): error is TenantFrozenError | TenantForgottenError =>
  error instanceof TenantFrozenError || error instanceof TenantForgottenError;
