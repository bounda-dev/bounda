import type { Adapter } from "../adapter/adapter.ts";
import type { Config } from "../config/types.ts";
import { createFixedClock, type FixedClock } from "../contracts/clock.ts";
import type { ConfigurationError } from "../contracts/errors.ts";
import { createSequentialIdGenerator, type IdGenerator } from "../contracts/ids.ts";
import { type Logger, silentLogger } from "../contracts/logger.ts";
import { assembleApp, type BoundaApp } from "../kernel/app.ts";
import { memory } from "../memory/index.ts";
import type { Registry } from "../modules/registry.ts";
import type {
  AppCollaboratorsConfig,
  AppTestCollaborators,
  EnvSection,
} from "../register/index.ts";

/**
 * `env` is what collaborator implementations receive in `create`, never the test's
 * `process.env`; `EnvSection` says when it is required.
 */
export type CreateTestAppArgs<R extends Registry> = {
  readonly registry: R;
  /**
   * Configuration without `storage`, which `adapter` replaces, nor `collaborators`, which the
   * option of that name replaces.
   */
  readonly config?: Omit<Config, "storage" | "collaborators">;
  /**
   * What each port of each aggregate receives, `{ order: { notifier: spy } }`: a double, handed
   * to the handlers as it is and never closed, or an implementation's file name, built with this
   * app's `env`, clock and logger and closed by `app.stop()`. A port left out has no
   * implementation, even when it has only one, so a test never reaches a provider it did not ask
   * for: reading it throws a `ConfigurationError`, which a command rejects with; once any handler
   * has read it, every `app.processUntilIdle()` throws it too, since a reaction does not retry it.
   */
  readonly collaborators?: AppTestCollaborators;
  /**
   * Defaults to the in-memory adapter.
   */
  readonly adapter?: Adapter;
  readonly logger?: Logger;
  /**
   * Where the fixed clock starts. Defaults to 2026-01-01T00:00:00Z.
   */
  readonly now?: Date;
} & EnvSection<R>;

export interface TestApp<R extends Registry> {
  readonly app: BoundaApp<R>;
  /**
   * The app's clock. Advance it to make scheduled commands and process time-outs due, then call
   * `app.processUntilIdle()`.
   */
  readonly clock: FixedClock;
  readonly ids: IdGenerator;
}

export interface CreateTestAppFunction {
  <R extends Registry>(args: CreateTestAppArgs<R>): Promise<TestApp<R>>;
}

/**
 * Creates an app for tests: in-memory storage, a clock that only moves when told to and
 * sequential ids (`id-1`, `id-2`, ...), so assertions are deterministic. Ports get only what
 * `collaborators` passes. Call `app.stop()` when done.
 */
export const createTestApp: CreateTestAppFunction = async <R extends Registry>({
  registry,
  config = {},
  collaborators = {},
  adapter = memory(),
  logger = silentLogger,
  now,
  env = {},
}: CreateTestAppArgs<R>): Promise<TestApp<R>> => {
  const clock = createFixedClock(now);
  const ids = createSequentialIdGenerator();
  // A reaction's failure stays in its dead letter, so the first port read without a value is
  // kept here for `processUntilIdle` to throw: the test fails saying what to pass.
  let missing: ConfigurationError | undefined;
  const app = await assembleApp<R>({
    registry,
    // Required by the `Config` of a project whose ports need a choice, and never read here:
    // `test` replaces it.
    config: { ...config, storage: adapter, collaborators: {} as AppCollaboratorsConfig },
    logger,
    ids,
    clock,
    env,
    test: {
      collaborators,
      onMissing: (error) => {
        missing ??= error;
      },
    },
  });
  return {
    app: {
      ...app,
      processUntilIdle: async (options) => {
        const result = await app.processUntilIdle(options);
        if (missing !== undefined) throw missing;
        return result;
      },
    },
    clock,
    ids,
  };
};

export { createFixedClock, type FixedClock } from "../contracts/clock.ts";
export { createSequentialIdGenerator } from "../contracts/ids.ts";
export { silentLogger } from "../contracts/logger.ts";
export { memory } from "../memory/index.ts";
