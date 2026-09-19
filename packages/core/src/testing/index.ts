import type { Adapter } from "../adapter/adapter.ts";
import type { Config } from "../config/types.ts";
import { createFixedClock, type FixedClock } from "../contracts/clock.ts";
import { createSequentialIdGenerator, type IdGenerator } from "../contracts/ids.ts";
import { type Logger, silentLogger } from "../contracts/logger.ts";
import { type BoundaApp, createApp } from "../kernel/app.ts";
import { memory } from "../memory/index.ts";
import type { Registry } from "../modules/registry.ts";

export interface CreateTestAppArgs<R extends Registry> {
  readonly registry: R;
  /**
   * Configuration without `storage`; the in-memory adapter is used unless `adapter` says
   * otherwise.
   */
  readonly config?: Omit<Config, "storage">;
  readonly adapter?: Adapter;
  readonly logger?: Logger;
  /**
   * Where the fixed clock starts. Defaults to 2026-01-01T00:00:00Z.
   */
  readonly now?: Date;
}

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
 * sequential ids (`id-1`, `id-2`, ...), so assertions are deterministic. Call `app.stop()` when
 * done.
 */
export const createTestApp: CreateTestAppFunction = async <R extends Registry>({
  registry,
  config = {},
  adapter = memory(),
  logger = silentLogger,
  now,
}: CreateTestAppArgs<R>): Promise<TestApp<R>> => {
  const clock = createFixedClock(now);
  const ids = createSequentialIdGenerator();
  const app = await createApp<R>({
    registry,
    config: { ...config, storage: adapter },
    logger,
    ids,
    clock,
  });
  return { app, clock, ids };
};

export { createFixedClock, type FixedClock } from "../contracts/clock.ts";
export { createSequentialIdGenerator } from "../contracts/ids.ts";
export { silentLogger } from "../contracts/logger.ts";
export { memory } from "../memory/index.ts";
