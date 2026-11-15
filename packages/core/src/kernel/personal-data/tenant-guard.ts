import { TenantForgottenError } from "../../contracts/errors.ts";

export interface GuardClientArgs {
  /**
   * Rejects once the tenant is known to be forgotten.
   */
  readonly ensureLive: () => Promise<void>;
  /**
   * Called when a call rejects with `TenantForgottenError`, which another instance's forgetting
   * makes a key operation throw.
   */
  readonly onForgotten: () => void;
}

export interface GuardClientFunction {
  (args: GuardClientArgs): <T>(value: T) => T;
}

// Every method, at any depth, checks the tenant first and reports a forgetting it runs into; what
// is not an object, and a promise's `then`, pass as they are.
export const guardClient: GuardClientFunction = ({ ensureLive, onForgotten }) => {
  const guarded = <T>(value: T): T => {
    if (typeof value !== "object" || value === null) return value;
    return new Proxy(value, {
      get: (target, property, receiver) => {
        const member: unknown = Reflect.get(target, property, receiver);
        if (property === "then") return member;
        if (typeof member === "function") {
          return async (...args: unknown[]) => {
            await ensureLive();
            try {
              return await (member as (...given: unknown[]) => unknown).apply(target, args);
            } catch (error) {
              if (error instanceof TenantForgottenError) onForgotten();
              throw error;
            }
          };
        }
        return guarded(member);
      },
    });
  };
  return guarded;
};
