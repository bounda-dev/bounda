import {
  type AppLag,
  type AppRegistry,
  type BoundaClient,
  type CommandsFacade,
  type Consistency,
  checkActor,
  checkConsistency,
  type DeadLetter,
  type DispatchOptions,
  type DispatchResult,
  type ForgetOptions,
  type ListDeadLettersArgs,
  type PersonalDataExport,
  type QueriesFacade,
  type ReadEventsArgs,
  type RebuildReadModelResult,
  type Registry,
  type StoredDispatch,
  type StoredEvent,
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
    actor?: string,
  ): PromiseLike<unknown>;
  query(name: string, payload?: unknown, actor?: string): PromiseLike<unknown>;
  lag(): PromiseLike<unknown>;
  readEvents(args?: ReadEventsArgs): PromiseLike<unknown>;
  listDeadLetters(args?: ListDeadLettersArgs, actor?: string): PromiseLike<unknown>;
  retryDeadLetter(id: string, actor?: string): PromiseLike<unknown>;
  discardDeadLetter(id: string, actor?: string): PromiseLike<unknown>;
  rebuildReadModel(name: string): PromiseLike<unknown>;
  forget(
    personId: string,
    consistency?: Consistency,
    actor?: string,
    options?: ForgetOptions,
  ): PromiseLike<unknown>;
  exportPersonalData(personId: string, actor?: string): PromiseLike<unknown>;
  restrict(personId: string, consistency?: Consistency, actor?: string): PromiseLike<unknown>;
  unrestrict(personId: string, consistency?: Consistency, actor?: string): PromiseLike<unknown>;
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
 * A typed client for a Bounda Durable Object: the same `commands` and `queries` as the app's,
 * typed from the registry, plus the operations an operator needs. Without a type argument it
 * takes the registry the generator registered, like `boot()`:
 *
 * ```ts
 * const store = connect(env.STORE.get(env.STORE.idFromName(tenant)));
 * await store.commands.placeOrder({ orderId, customerId, total });
 * ```
 *
 * Every call is a round trip to the object. A command's `signal` only counts before the call
 * leaves the Worker: RPC cannot carry it into the object, where the command then runs to the end.
 * `as(actor)` sends the actor with every call, and the object acts as it. Throws
 * `ConfigurationError` for a `consistency` it does not know.
 */
export const connect: ConnectFunction = <R extends Registry = AppRegistry>(
  stub: BoundaStub,
  { consistency = "read-your-writes" }: ConnectOptions = {},
): BoundaClient<R> => {
  checkConsistency(consistency);
  const clientAs = (actor: string | undefined): BoundaClient<R> => ({
    commands: byName<CommandsFacade<R>>(async (name, payload, options) =>
      unwrap<DispatchResult>(
        stub.command(
          name,
          payload,
          sendable(options as DispatchOptions | undefined),
          consistency,
          actor,
        ),
      ),
    ),
    queries: byName<QueriesFacade<R>>((name, payload) => unwrap(stub.query(name, payload, actor))),
    getLag: () => unwrap<AppLag>(stub.lag()),
    events: { read: (args) => unwrap<readonly StoredEvent[]>(stub.readEvents(args)) },
    deadLetters: {
      list: (args) => unwrap<readonly DeadLetter[]>(stub.listDeadLetters(args, actor)),
      retry: (id) => unwrap<DeadLetter>(stub.retryDeadLetter(id, actor)),
      discard: (id) => unwrap<DeadLetter>(stub.discardDeadLetter(id, actor)),
    },
    rebuildReadModel: (name) => unwrap<RebuildReadModelResult>(stub.rebuildReadModel(name)),
    forget: (personId, options) =>
      unwrap<StoredDispatch>(stub.forget(personId, consistency, actor, options)),
    exportPersonalData: (personId) =>
      unwrap<PersonalDataExport>(stub.exportPersonalData(personId, actor)),
    restrict: (personId) => unwrap<StoredDispatch>(stub.restrict(personId, consistency, actor)),
    unrestrict: (personId) => unwrap<StoredDispatch>(stub.unrestrict(personId, consistency, actor)),
    as: (next) => {
      checkActor(next);
      return clientAs(next);
    },
  });
  return clientAs(undefined);
};
