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
  /**
   * The code of a command's rejection, set on a `DomainError`.
   */
  readonly rejected?: string;
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

export interface RefusalOfFunction {
  (error: unknown): RpcRefusal | null;
}

export const refusalOf: RefusalOfFunction = (error) => {
  if (!(error instanceof BoundaError)) return null;
  const issues = Reflect.get(error, "issues");
  const rejected = Reflect.get(error, "rejected");
  return {
    name: error.name,
    code: error.code,
    message: error.message,
    ...(issues === undefined ? {} : { issues }),
    ...(typeof rejected === "string" ? { rejected } : {}),
  };
};

/**
 * Only a `BoundaError` becomes a refusal: any other error is thrown as it is.
 */
export const settle: SettleFunction = async (work) => {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal === null) throw error;
    return { ok: false, refusal };
  }
};

export interface UnwrapFunction {
  <T>(pending: PromiseLike<unknown>): Promise<T>;
}

export interface RefusedFunction {
  (refusal: RpcRefusal): Error;
}

export const refused: RefusedFunction = ({ name, code, message, issues, rejected }) =>
  Object.assign(new Error(message), {
    name,
    code,
    ...(issues === undefined ? {} : { issues }),
    ...(rejected === undefined ? {} : { rejected }),
  });

export const unwrap: UnwrapFunction = async <T>(pending: PromiseLike<unknown>): Promise<T> => {
  const outcome = (await pending) as RpcOutcome<T>;
  if (outcome.ok) return outcome.value;
  throw refused(outcome.refusal);
};
