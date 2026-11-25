import { type Clock, systemClock } from "../contracts/clock.ts";
import {
  ConfigurationError,
  TenantForgottenError,
  TenantFrozenError,
} from "../contracts/errors.ts";
import type { Logger } from "../contracts/logger.ts";
import type { HostRejection, HostRejectionReason, OnHostRejection } from "../modules/audit.ts";
import type { Registry } from "../modules/registry.ts";
import type { AppEnv } from "../register/index.ts";

/**
 * The message a host log record goes to the logger under without `app/audit.ts`.
 */
export const HOST_REJECTED = "request refused";

export interface RecordHostRejectionArgs {
  readonly tenant: string | null;
  readonly reason: HostRejectionReason;
  readonly target: string | null;
  readonly actor: string | null;
}

/**
 * Records one request refused before the app served it, in the host log: to `onHostRejection` of
 * `app/audit.ts`, or to the logger at `info` without it. Rejects with what `onHostRejection`
 * throws, which the refusal then rejects with in place of its own.
 */
export interface RecordHostRejection {
  (args: RecordHostRejectionArgs): Promise<void>;
}

export interface CreateHostLogArgs {
  readonly hook: OnHostRejection | undefined;
  readonly env: AppEnv;
  readonly logger: Logger;
  readonly clock: Clock;
}

export interface CreateHostLogFunction {
  (args: CreateHostLogArgs): RecordHostRejection;
}

export const createHostLog: CreateHostLogFunction =
  ({ hook, env, logger, clock }) =>
  async ({ tenant, reason, target, actor }) => {
    const rejection: HostRejection = {
      at: clock.now().toISOString(),
      tenant,
      reason,
      target,
      actor,
    };
    if (hook === undefined) {
      logger.info(HOST_REJECTED, { ...rejection });
      return;
    }
    await hook({ rejection, env, logger });
  };

export interface HostLogOfArgs {
  /**
   * The project's registry: its `app/audit.ts` receives the records. Left out, or without
   * `app/audit.ts`, they go to `logger` at `info`, under `HOST_REJECTED`.
   */
  readonly registry?: Pick<Registry, "audit"> | undefined;
  /**
   * What `onHostRejection` receives as `env`: `process.env`, or the Worker's.
   */
  readonly env: object;
  readonly logger: Logger;
  /**
   * Defaults to the wall clock.
   */
  readonly clock?: Clock | undefined;
}

export interface HostLogOfFunction {
  (args: HostLogOfArgs): RecordHostRejection;
}

/**
 * The host log of a host that serves an app's requests, for a host of its own: each request it
 * refuses before the app serves it, with no tenant, actor or route it takes, or a body it cannot
 * read, is recorded once, before the refusal goes out, as the hosts Bounda ships do. Throws
 * `ConfigurationError` when the registry's `app/audit.ts` does not export `onHostRejection`.
 */
export const hostLogOf: HostLogOfFunction = ({ registry, env, logger, clock = systemClock }) => {
  const audit = registry?.audit;
  const hook: unknown = audit === undefined ? undefined : Reflect.get(audit, "onHostRejection");
  if (audit !== undefined && typeof hook !== "function") {
    throw new ConfigurationError(
      "app/audit.ts does not export onHostRejection, the function the host log goes to",
    );
  }
  return createHostLog({
    hook: hook as OnHostRejection | undefined,
    env: env as AppEnv,
    logger,
    clock,
  });
};

const reasonOf = (error: unknown): HostRejectionReason | null =>
  error instanceof TenantForgottenError
    ? "tenant-forgotten"
    : error instanceof TenantFrozenError
      ? "tenant-frozen"
      : null;

// What a client's nested facades are; any other object it holds is handed out as it is.
const FACADES: ReadonlySet<string> = new Set([
  "commands",
  "queries",
  "subscriberFailures",
  "events",
  "deadLetters",
]);

export interface RecordedRejectionsArgs<Client> {
  readonly client: Client;
  readonly record: RecordHostRejection;
  readonly tenant: string;
  readonly actor: string | undefined;
}

export interface RecordedRejectionsFunction {
  <Client extends object>(args: RecordedRejectionsArgs<Client>): Client;
}

/**
 * The client, each call of which that rejects because of its tenant's state, forgotten or frozen,
 * recorded in the host log before it rejects. `as` is handed out as it is: the client it returns
 * is the caller's to wrap.
 */
export const recordedRejections: RecordedRejectionsFunction = ({
  client,
  record,
  tenant,
  actor,
}) => {
  const settled = async (pending: PromiseLike<unknown>, target: string): Promise<unknown> => {
    try {
      return await pending;
    } catch (error) {
      const reason = reasonOf(error);
      if (reason !== null) await record({ tenant, reason, target, actor: actor ?? null });
      throw error;
    }
  };
  // Each member is watched through one proxy per path, so it reads the same every time.
  const watching = new WeakMap<object, Map<string, object>>();
  // Below the client, every member is watched: a facade's keys are the app's, or any at all.
  const watch = <T>(value: T, path: string): T => {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
    const paths = watching.get(value) ?? new Map<string, object>();
    watching.set(value, paths);
    const known = paths.get(path);
    if (known !== undefined) return known as T;
    const watched = new Proxy(value as T & object, {
      get: (target, property, receiver) => {
        const member: unknown = Reflect.get(target, property, receiver);
        // A proxy must hand out a frozen member as it is.
        const own = Reflect.getOwnPropertyDescriptor(target, property);
        if (typeof property !== "string" || own?.configurable === false) return member;
        return watch(member, `${path}.${property}`);
      },
      apply: (target, self, args) => {
        const result: unknown = Reflect.apply(
          target as (...given: unknown[]) => unknown,
          self,
          args,
        );
        return isThenable(result) ? settled(result, path) : result;
      },
    });
    paths.set(path, watched);
    return watched;
  };
  return new Proxy(client, {
    get: (target, property, receiver) => {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || property === "as") return member;
      return typeof member === "function" || FACADES.has(property)
        ? watch(member, property)
        : member;
    },
  });
};

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof Reflect.get(value, "then") === "function";
