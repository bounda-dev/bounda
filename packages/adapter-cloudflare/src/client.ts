import {
  type AppLag,
  type AppRegistry,
  type CommandsFacade,
  ConfigurationError,
  type Consistency,
  type DeadLetter,
  type DispatchOptions,
  type DispatchResult,
  type ListDeadLettersArgs,
  type QueriesFacade,
  type RebuildReadModelResult,
  type Registry,
} from "@bounda-dev/core";
import { unwrap } from "./outcome.ts";

/**
 * The methods of a Bounda object's stub that `connect` calls. Structural on purpose: a stub from
 * `env.STORE.get(id)` fits, whatever Cloudflare's RPC types map its results to. Each answers an
 * outcome, which `connect` unwraps.
 */
export interface BoundaStub {
  command(
    name: string,
    payload?: unknown,
    options?: DispatchOptions,
    consistency?: Consistency,
  ): PromiseLike<unknown>;
  query(name: string, payload?: unknown): PromiseLike<unknown>;
  lag(): PromiseLike<unknown>;
  listDeadLetters(args?: ListDeadLettersArgs): PromiseLike<unknown>;
  retryDeadLetter(id: string): PromiseLike<unknown>;
  discardDeadLetter(id: string): PromiseLike<unknown>;
  rebuildReadModel(name: string): PromiseLike<unknown>;
}

/**
 * One store, seen from a Worker: the same `commands` and `queries` as `app.commands` and
 * `app.queries`, typed from the registry, plus the operations an operator needs. Every call is a
 * round trip to the object. A command's `signal` only counts before the call leaves the Worker:
 * RPC cannot carry it into the object, where the command then runs to the end.
 */
export interface BoundaClient<R extends Registry> {
  readonly commands: CommandsFacade<R>;
  readonly queries: QueriesFacade<R>;
  getLag(): Promise<AppLag>;
  readonly deadLetters: {
    list(args?: ListDeadLettersArgs): Promise<readonly DeadLetter[]>;
    retry(id: string): Promise<DeadLetter>;
    discard(id: string): Promise<DeadLetter>;
  };
  /**
   * Runs the first slice of a rebuild; when it is not `done`, the object's alarm finishes it.
   */
  rebuildReadModel(name: string): Promise<RebuildReadModelResult>;
}

export interface ConnectOptions {
  /**
   * Whether a command resolves once the read models reflect it, `"read-your-writes"` by default,
   * or as soon as its events are stored, `"eventual"`, with the object's alarm projecting them
   * right after.
   */
  readonly consistency?: Consistency;
}

export interface ConnectFunction {
  <R extends Registry = AppRegistry>(stub: BoundaStub, options?: ConnectOptions): BoundaClient<R>;
}

export interface CheckConsistencyFunction {
  (consistency: Consistency): void;
}

// A Worker's code is not always type-checked.
export const checkConsistency: CheckConsistencyFunction = (consistency) => {
  if (consistency !== "read-your-writes" && consistency !== "eventual") {
    throw new ConfigurationError(
      `consistency must be "read-your-writes" or "eventual", got ${JSON.stringify(consistency)}`,
    );
  }
};

const sendable = (options: DispatchOptions | undefined): DispatchOptions | undefined => {
  if (options === undefined) return undefined;
  const { signal, ...rest } = options;
  signal?.throwIfAborted();
  return rest;
};

const byName = <T extends object>(call: (name: string, ...args: unknown[]) => unknown): T =>
  new Proxy({} as T, {
    get: (_target, key) =>
      // Without a `then`, awaiting or returning the proxy does not take it for a promise.
      typeof key === "string" && key !== "then"
        ? (...args: unknown[]) => call(key, ...args)
        : undefined,
  });

/**
 * A typed client for a Bounda Durable Object. Without a type argument it takes the registry the
 * generator registered, like `boot()`:
 *
 * ```ts
 * const store = connect(env.STORE.get(env.STORE.idFromName(tenant)));
 * await store.commands.placeOrder({ orderId, customerId, total });
 * ```
 *
 * Throws `ConfigurationError` for a `consistency` it does not know.
 */
export const connect: ConnectFunction = <R extends Registry = AppRegistry>(
  stub: BoundaStub,
  { consistency = "read-your-writes" }: ConnectOptions = {},
): BoundaClient<R> => {
  checkConsistency(consistency);
  return {
    commands: byName<CommandsFacade<R>>(async (name, payload, options) =>
      unwrap<DispatchResult>(
        stub.command(name, payload, sendable(options as DispatchOptions | undefined), consistency),
      ),
    ),
    queries: byName<QueriesFacade<R>>((name, payload) => unwrap(stub.query(name, payload))),
    getLag: () => unwrap<AppLag>(stub.lag()),
    deadLetters: {
      list: (args) => unwrap<readonly DeadLetter[]>(stub.listDeadLetters(args)),
      retry: (id) => unwrap<DeadLetter>(stub.retryDeadLetter(id)),
      discard: (id) => unwrap<DeadLetter>(stub.discardDeadLetter(id)),
    },
    rebuildReadModel: (name) => unwrap<RebuildReadModelResult>(stub.rebuildReadModel(name)),
  };
};
