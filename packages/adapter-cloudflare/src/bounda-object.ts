import { DurableObject } from "cloudflare:workers";
import {
  type BoundaApp,
  type Clock,
  ConfigurationError,
  createApp,
  type DeadLetter,
  type DispatcherLag,
  type DispatchOptions,
  type DispatchResult,
  type IdGenerator,
  type ListDeadLettersArgs,
  type Logger,
  NotFoundError,
  type RebuildReadModelResult,
  type Registry,
  systemClock,
} from "@bounda-dev/core";
import type { Config } from "@bounda-dev/core/config";
import { durableObjectAdapter } from "./adapter.ts";
import { isCloudflareDefinition } from "./definition.ts";
import { workersLogger } from "./logger.ts";
import { type RpcOutcome, settle } from "./outcome.ts";
import type { DurableSqlStorage } from "./sql-database.ts";
import { nextWake } from "./wake.ts";

export interface CreateBoundaObjectArgs<R extends Registry> {
  readonly registry: R;
  /**
   * The app's configuration, with `storage: cloudflare()`. Read models configured with
   * `cloudflare()` live in the same object; any other adapter is used as it is.
   */
  readonly config: Config;
  /**
   * At most this many rounds of dispatcher passes and due commands per alarm before the object
   * yields and wakes itself again. Defaults to 50.
   */
  readonly passesPerAlarm?: number;
  /**
   * At most about this many events per slice of a read model rebuild: the request that starts it
   * runs the first slice, and each alarm runs the next until the rebuilt table is swapped in.
   * Defaults to 5,000.
   */
  readonly eventsPerRebuildSlice?: number;
  readonly logger?: Logger;
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
}

/**
 * What a Bounda Durable Object answers over RPC. Every method runs inside the object, in order,
 * and answers an outcome: its value, or the refusal it threw as plain data, so `code` and
 * `issues` survive RPC on every compatibility date. Call it through `connect(stub)`, which types
 * commands and queries from the registry and throws refusals again.
 */
export interface BoundaObjectMethods {
  /**
   * Dispatches a command. When it resolves its events are stored and every read model reflects
   * them, so a query issued next sees them. Policies and processes run right after, in the
   * object's alarm.
   */
  command(
    name: string,
    payload?: unknown,
    options?: DispatchOptions,
  ): Promise<RpcOutcome<DispatchResult>>;
  query(name: string, payload?: unknown): Promise<RpcOutcome<unknown>>;
  lag(): Promise<RpcOutcome<DispatcherLag>>;
  listDeadLetters(args?: ListDeadLettersArgs): Promise<RpcOutcome<readonly DeadLetter[]>>;
  replayDeadLetter(id: string): Promise<RpcOutcome<DeadLetter>>;
  discardDeadLetter(id: string): Promise<RpcOutcome<DeadLetter>>;
  /**
   * Starts or continues rebuilding a read model with one slice of `eventsPerRebuildSlice` events.
   * When the result is not `done` the object's alarm runs the next slices, one per alarm, until
   * the rebuilt table takes the live one's place; queries keep reading the live table meanwhile.
   */
  rebuildReadModel(name: string): Promise<RpcOutcome<RebuildReadModelResult>>;
  /**
   * Runs the next slice of every paused rebuild, then policies, processes, due scheduled commands
   * and retries, in bounded slices, and arms the next alarm. Called by the platform.
   */
  alarm(): Promise<void>;
}

/**
 * The class `createBoundaObject` returns, to export from the Worker and bind in `wrangler.jsonc`.
 */
export interface BoundaObjectClass {
  new (ctx: DurableObjectState, env: Cloudflare.Env): DurableObject & BoundaObjectMethods;
}

export interface CreateBoundaObjectFunction {
  <R extends Registry>(args: CreateBoundaObjectArgs<R>): BoundaObjectClass;
}

const DEFAULT_PASSES_PER_ALARM = 50;
const DEFAULT_EVENTS_PER_REBUILD_SLICE = 5_000;
const MIN_RETRY_MS = 1_000;

export interface ConfigForObjectFunction {
  (config: Config, storage: DurableSqlStorage): Config;
}

/**
 * The configuration an object's app runs on: `cloudflare()` definitions replaced by the adapter
 * over the object's own storage, anything else kept.
 */
export const configForObject: ConfigForObjectFunction = (config, storage) => {
  if (!isCloudflareDefinition(config.storage)) {
    throw new ConfigurationError(
      `A Bounda Durable Object stores its events in its own SQLite: set storage to cloudflare(), not "${config.storage.name}"`,
    );
  }
  const own = (options: { readonly tablePrefix?: string }) =>
    durableObjectAdapter({ storage, options });
  return {
    ...config,
    storage: own(config.storage.options),
    ...(config.readModels === undefined
      ? {}
      : {
          readModels: Object.fromEntries(
            Object.entries(config.readModels).map(([name, definition]) => [
              name,
              isCloudflareDefinition(definition) ? own(definition.options) : definition,
            ]),
          ),
        }),
  };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Builds the Durable Object class that runs one Bounda store: the app's events, ledgers and read
 * models in the object's SQLite, with no background loop. A command updates the read models
 * before it resolves; policies, processes, scheduled commands and retries run in the object's
 * alarm, which it arms itself for whatever comes next. One object is one store: give each tenant
 * its own with `idFromName(tenant)`.
 */
export const createBoundaObject: CreateBoundaObjectFunction = <R extends Registry>({
  registry,
  config,
  passesPerAlarm = DEFAULT_PASSES_PER_ALARM,
  eventsPerRebuildSlice = DEFAULT_EVENTS_PER_REBUILD_SLICE,
  logger = workersLogger,
  ids,
  clock = systemClock,
}: CreateBoundaObjectArgs<R>): BoundaObjectClass =>
  class BoundaObject extends DurableObject implements BoundaObjectMethods {
    #app: BoundaApp<R> | undefined;

    constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
      super(ctx, env);
      void ctx.blockConcurrencyWhile(async () => {
        this.#app = await createApp<R>({
          registry,
          config: configForObject(config, ctx.storage),
          logger,
          clock,
          ...(ids === undefined ? {} : { ids }),
        });
      });
    }

    #ready(): BoundaApp<R> {
      if (this.#app === undefined) throw new ConfigurationError("The Bounda app is not ready");
      return this.#app;
    }

    async #rearm(settled: boolean, idle: boolean, rebuildFailed = false): Promise<void> {
      const app = this.#ready();
      const [lag, due, rebuilds] = await Promise.all([
        app.getLag(),
        app.nextDueAt(),
        app.pendingRebuilds(),
      ]);
      const now = clock.now().getTime();
      const at = nextWake({
        idle,
        settled,
        lag: lag.maxLag,
        rebuild: rebuilds.length === 0 ? "none" : rebuildFailed ? "held" : "next",
        due,
        now,
        retryMs: Math.max(app.config.runtime.dispatcher.pollIntervalMs, MIN_RETRY_MS),
      });
      if (at === null) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + (at - now));
    }

    async #continueRebuilds(): Promise<boolean> {
      const app = this.#ready();
      let failed = false;
      for (const name of await app.pendingRebuilds()) {
        try {
          const { done, position } = await app.rebuildReadModel(name, {
            maxEvents: eventsPerRebuildSlice,
          });
          logger.info(done ? "bounda rebuild finished" : "bounda rebuild continues", {
            readModel: name,
            position,
          });
        } catch (error) {
          failed = true;
          logger.error("bounda rebuild slice failed", {
            readModel: name,
            message: errorMessage(error),
          });
        }
      }
      return failed;
    }

    command(
      name: string,
      payload?: unknown,
      options?: DispatchOptions,
    ): Promise<RpcOutcome<DispatchResult>> {
      return settle(async () => {
        const app = this.#ready();
        const dispatch = Reflect.get(app.commands, name) as
          | ((payload?: unknown, options?: DispatchOptions) => Promise<DispatchResult>)
          | undefined;
        if (typeof dispatch !== "function") throw new NotFoundError(`Unknown command "${name}"`);
        const result = await dispatch(payload, options);
        if (!result.scheduled) await app.catchUpReadModels();
        await this.#rearm(false, true);
        return result;
      });
    }

    query(name: string, payload?: unknown): Promise<RpcOutcome<unknown>> {
      return settle(async () => {
        const run = Reflect.get(this.#ready().queries, name) as
          | ((payload?: unknown) => Promise<unknown>)
          | undefined;
        if (typeof run !== "function") throw new NotFoundError(`Unknown query "${name}"`);
        return run(payload);
      });
    }

    lag(): Promise<RpcOutcome<DispatcherLag>> {
      return settle(() => this.#ready().getLag());
    }

    listDeadLetters(args?: ListDeadLettersArgs): Promise<RpcOutcome<readonly DeadLetter[]>> {
      return settle(() => this.#ready().deadLetters.list(args));
    }

    replayDeadLetter(id: string): Promise<RpcOutcome<DeadLetter>> {
      return settle(async () => {
        const letter = await this.#ready().deadLetters.replay(id);
        await this.#rearm(false, true);
        return letter;
      });
    }

    discardDeadLetter(id: string): Promise<RpcOutcome<DeadLetter>> {
      return settle(() => this.#ready().deadLetters.discard(id));
    }

    rebuildReadModel(name: string): Promise<RpcOutcome<RebuildReadModelResult>> {
      return settle(async () => {
        const result = await this.#ready().rebuildReadModel(name, {
          maxEvents: eventsPerRebuildSlice,
        });
        await this.#rearm(false, true);
        return result;
      });
    }

    override async alarm(): Promise<void> {
      let idle = true;
      let rebuildFailed = false;
      try {
        rebuildFailed = await this.#continueRebuilds();
      } catch (error) {
        rebuildFailed = true;
        logger.error("bounda rebuilds could not be listed", { message: errorMessage(error) });
      }
      try {
        ({ idle } = await this.#ready().processUntilIdle({ maxPasses: passesPerAlarm }));
      } catch (error) {
        logger.error("bounda alarm failed; it will be retried", { message: errorMessage(error) });
      }
      try {
        await this.#rearm(true, idle, rebuildFailed);
      } catch (error) {
        logger.error("bounda alarm could not re-arm", { message: errorMessage(error) });
      }
    }
  };
