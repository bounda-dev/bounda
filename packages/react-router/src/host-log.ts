import { type HostRejectionReason, hostLogOf, type Logger, type Registry } from "@bounda-dev/core";
import type { RequestArgs } from "./actor.ts";

export interface KnownOfRequest {
  readonly tenant?: string;
  readonly actor?: string;
}

/**
 * Records a request the host refuses before the app serves it, in the host log, under the
 * pattern of its route; rejects with what `onHostRejection` throws.
 */
export interface RefuseRequestFunction {
  (args: RequestArgs, reason: HostRejectionReason, known?: KnownOfRequest): Promise<void>;
}

export interface RequestRefusalsArgs {
  readonly registry: Pick<Registry, "audit"> | undefined;
  readonly env: object;
  readonly logger: () => Logger | Promise<Logger>;
}

export interface RequestRefusalsFunction {
  (args: RequestRefusalsArgs): RefuseRequestFunction;
}

export const requestRefusals: RequestRefusalsFunction =
  ({ registry, env, logger }) =>
  async (args, reason, { tenant, actor } = {}) => {
    await hostLogOf({ registry, env, logger: await logger() })({
      tenant: tenant ?? null,
      reason,
      target: args.pattern,
      actor: actor ?? null,
    });
  };
