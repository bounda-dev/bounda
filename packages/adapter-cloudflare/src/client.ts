import type {
  AppRegistry,
  CommandsFacade,
  DeadLetter,
  DispatcherLag,
  DispatchOptions,
  DispatchResult,
  ListDeadLettersArgs,
  QueriesFacade,
  RebuildReadModelResult,
  Registry,
} from "@bounda-dev/core";
import { unwrap } from "./outcome.ts";

/**
 * The methods of a Bounda object's stub that `connect` calls. Structural on purpose: a stub from
 * `env.STORE.get(id)` fits, whatever Cloudflare's RPC types map its results to. Each answers an
 * outcome, which `connect` unwraps.
 */
export interface BoundaStub {
  command(name: string, payload?: unknown, options?: DispatchOptions): PromiseLike<unknown>;
  query(name: string, payload?: unknown): PromiseLike<unknown>;
  lag(): PromiseLike<unknown>;
  listDeadLetters(args?: ListDeadLettersArgs): PromiseLike<unknown>;
  replayDeadLetter(id: string): PromiseLike<unknown>;
  discardDeadLetter(id: string): PromiseLike<unknown>;
  rebuildReadModel(name: string): PromiseLike<unknown>;
}

/**
 * One store, seen from a Worker: the same `commands` and `queries` as `app.commands` and
 * `app.queries`, typed from the registry, plus the operations an operator needs. Every call is a
 * round trip to the object.
 */
export interface BoundaClient<R extends Registry> {
  readonly commands: CommandsFacade<R>;
  readonly queries: QueriesFacade<R>;
  getLag(): Promise<DispatcherLag>;
  readonly deadLetters: {
    list(args?: ListDeadLettersArgs): Promise<readonly DeadLetter[]>;
    replay(id: string): Promise<DeadLetter>;
    discard(id: string): Promise<DeadLetter>;
  };
  /**
   * Runs the first slice of a rebuild; when it is not `done`, the object's alarm finishes it.
   */
  rebuildReadModel(name: string): Promise<RebuildReadModelResult>;
}

export interface ConnectFunction {
  <R extends Registry = AppRegistry>(stub: BoundaStub): BoundaClient<R>;
}

const byName = <T extends object>(call: (name: string, ...args: unknown[]) => unknown): T =>
  new Proxy({} as T, {
    get: (_target, key) =>
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
 */
export const connect: ConnectFunction = <R extends Registry = AppRegistry>(
  stub: BoundaStub,
): BoundaClient<R> => ({
  commands: byName<CommandsFacade<R>>((name, payload, options) =>
    unwrap<DispatchResult>(stub.command(name, payload, options as DispatchOptions | undefined)),
  ),
  queries: byName<QueriesFacade<R>>((name, payload) => unwrap(stub.query(name, payload))),
  getLag: () => unwrap<DispatcherLag>(stub.lag()),
  deadLetters: {
    list: (args) => unwrap<readonly DeadLetter[]>(stub.listDeadLetters(args)),
    replay: (id) => unwrap<DeadLetter>(stub.replayDeadLetter(id)),
    discard: (id) => unwrap<DeadLetter>(stub.discardDeadLetter(id)),
  },
  rebuildReadModel: (name) => unwrap<RebuildReadModelResult>(stub.rebuildReadModel(name)),
});
