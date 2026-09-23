import { BoundaError } from "@bounda-dev/core";

/**
 * A refusal as it crosses RPC: what a `BoundaError` carries, as plain data. Workers before the
 * 2026 compatibility dates drop an error's own properties on the way, `code` and `issues`
 * included, so a Bounda object answers refusals with this instead of throwing them.
 */
export interface RpcRefusal {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly issues?: unknown;
}

/**
 * What every method of a Bounda object answers over RPC: its value, or the refusal it threw.
 */
export type RpcOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: RpcRefusal };

export interface SettleFunction {
  <T>(work: () => Promise<T>): Promise<RpcOutcome<T>>;
}

/**
 * Runs `work` and wraps its result, or the `BoundaError` it threw, as an outcome. Any other error
 * is thrown as it is.
 */
export const settle: SettleFunction = async (work) => {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (!(error instanceof BoundaError)) throw error;
    const issues = Reflect.get(error, "issues");
    return {
      ok: false,
      refusal: {
        name: error.name,
        code: error.code,
        message: error.message,
        ...(issues === undefined ? {} : { issues }),
      },
    };
  }
};

export interface UnwrapFunction {
  <T>(pending: PromiseLike<unknown>): Promise<T>;
}

/**
 * The value of an outcome, or its refusal thrown again as an `Error` with the same `name`,
 * `message`, `code` and `issues`.
 */
export const unwrap: UnwrapFunction = async <T>(pending: PromiseLike<unknown>): Promise<T> => {
  const outcome = (await pending) as RpcOutcome<T>;
  if (outcome.ok) return outcome.value;
  const { name, code, message, issues } = outcome.refusal;
  throw Object.assign(new Error(message), {
    name,
    code,
    ...(issues === undefined ? {} : { issues }),
  });
};
