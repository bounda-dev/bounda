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

/**
 * The methods of a Bounda object's stub that `connect` calls. Structural on purpose: a stub from
 * `env.STORE.get(id)` fits, whatever Cloudflare's RPC types map its results to.
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
  commands: byName<CommandsFacade<R>>(
    (name, payload, options) =>
      stub.command(
        name,
        payload,
        options as DispatchOptions | undefined,
      ) as Promise<DispatchResult>,
  ),
  queries: byName<QueriesFacade<R>>((name, payload) => stub.query(name, payload)),
  getLag: async () => (await stub.lag()) as DispatcherLag,
  deadLetters: {
    list: async (args) => (await stub.listDeadLetters(args)) as readonly DeadLetter[],
    replay: async (id) => (await stub.replayDeadLetter(id)) as DeadLetter,
    discard: async (id) => (await stub.discardDeadLetter(id)) as DeadLetter,
  },
  rebuildReadModel: async (name) => (await stub.rebuildReadModel(name)) as RebuildReadModelResult,
});
