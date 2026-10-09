import { randomUUID } from "node:crypto";
import { rm, watch as watchDirectory, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Clock, systemClock } from "@bounda-dev/core";
import { isInGenerated } from "./write.ts";

export type WatchFunction = typeof watchDirectory;

export interface WatchProjectArgs {
  readonly root: string;
  /**
   * The application directory under `root`. Defaults to `app`.
   */
  readonly appDir?: string;
  /**
   * Runs once per burst of changes, after `debounceMs` of quiet. A rejection goes to `onError`
   * and watching goes on.
   */
  readonly onChange: () => Promise<void>;
  readonly onError?: (error: unknown) => void;
  /**
   * Called once the watcher is known to be listening: a change made from then on is seen.
   */
  readonly onListening?: () => void;
  /**
   * Called instead of `onListening` when the watch gives up confirming it: the file system may
   * not report changes here. Watching goes on.
   */
  readonly onUnconfirmed?: () => void;
  /**
   * Quiet time after the last change before `onChange` runs. Defaults to 100 ms.
   */
  readonly debounceMs?: number;
  /**
   * What the quiet time and the cookie's retries are measured on. Defaults to the wall clock.
   */
  readonly clock?: Clock;
  readonly signal: AbortSignal;
  readonly watch?: WatchFunction;
}

export interface WatchProjectFunction {
  (args: WatchProjectArgs): Promise<void>;
}

const COOKIE_RETRY_MS = 50;

const COOKIE_ATTEMPTS = 20;

const isGenerated = (fileName: string | Buffer | null): boolean =>
  typeof fileName === "string" && isInGenerated(fileName);

/**
 * Watches the application directory and calls `onChange` after each burst of changes to user
 * modules, ignoring `+types` and `.bounda`. The operating system may start listening late and
 * miss earlier changes (FSEvents on macOS does), so the watch writes a cookie file into the
 * directory until it hears it back, then removes it and calls `onListening`, or `onUnconfirmed`
 * once it gives up.
 * Resolves when the signal aborts; rejects when the watcher, or writing the cookie, fails.
 */
export const watchProject: WatchProjectFunction = async ({
  root,
  appDir = "app",
  onChange,
  onError = () => undefined,
  onListening = () => undefined,
  onUnconfirmed = () => undefined,
  debounceMs = 100,
  clock = systemClock,
  signal,
  watch = watchDirectory,
}) => {
  const directory = join(root, appDir);
  const cookie = `.bounda-watch-${randomUUID()}`;
  const failed = new AbortController();
  const heard = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  let over = false;
  let failure: { readonly error: unknown } | undefined;
  let cancelPending: (() => void) | undefined;
  let running: Promise<void> = Promise.resolve();
  const schedule = (): void => {
    cancelPending?.();
    cancelPending = clock.after(debounceMs, () => {
      running = running.then(onChange).catch(onError);
    });
  };
  const listen = async (): Promise<boolean> => {
    const path = join(directory, cookie);
    try {
      for (let attempt = 1; attempt <= COOKIE_ATTEMPTS; attempt += 1) {
        await writeFile(path, "");
        const retry = Promise.withResolvers<"retry">();
        const cancelRetry = clock.after(COOKIE_RETRY_MS, () => retry.resolve("retry"));
        const outcome = await Promise.race([heard.promise, ended.promise, retry.promise]);
        cancelRetry();
        if (outcome !== "retry") return true;
      }
      return false;
    } finally {
      await rm(path, { force: true });
    }
  };
  const events = watch(directory, {
    recursive: true,
    signal: AbortSignal.any([signal, failed.signal]),
  })[Symbol.asyncIterator]();
  const first = events.next();
  const listening = listen()
    .then(
      (confirmed) => {
        if (over) return;
        if (confirmed) onListening();
        else onUnconfirmed();
      },
      (error: unknown) => {
        if (over) return;
        failure = { error };
        failed.abort();
      },
    )
    .catch(onError);
  try {
    for (let result = await first; result.done !== true; result = await events.next()) {
      const { filename } = result.value;
      if (filename === cookie) heard.resolve();
      else if (!isGenerated(filename)) schedule();
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) throw error;
  } finally {
    over = true;
    ended.resolve();
    cancelPending?.();
    await Promise.all([running, listening]);
  }
  if (failure !== undefined) throw failure.error;
};

export interface WatchFromFirstRunArgs extends Omit<WatchProjectArgs, "onListening"> {
  /**
   * Resolves to whether watching goes on; a rejection ends the watch and is rethrown.
   */
  readonly firstRun: () => Promise<boolean>;
  readonly onWatching: () => void;
}

export interface WatchFromFirstRunFunction {
  (args: WatchFromFirstRunArgs): Promise<void>;
}

/**
 * The first run waits for the watcher to listen, so a change made during it is not lost: that
 * change goes to `onChange` once the run is done.
 */
export const watchFromFirstRun: WatchFromFirstRunFunction = async ({
  firstRun,
  onWatching,
  onChange,
  onUnconfirmed = () => undefined,
  signal,
  ...project
}) => {
  const stopWatching = new AbortController();
  const watchSignal = AbortSignal.any([signal, stopWatching.signal]);
  const listening = Promise.withResolvers<void>();
  const firstRunDone = Promise.withResolvers<void>();
  const watching = watchProject({
    ...project,
    signal: watchSignal,
    onListening: listening.resolve,
    onUnconfirmed: () => {
      onUnconfirmed();
      listening.resolve();
    },
    onChange: async () => {
      await firstRunDone.promise;
      if (!watchSignal.aborted) await onChange();
    },
  });
  let ended = false;
  const watchEnded = watching.then(
    () => {
      ended = true;
    },
    () => {
      ended = true;
    },
  );
  await Promise.race([listening.promise, watchEnded]);
  if (signal.aborted) {
    await watching;
    return;
  }
  let goesOn = false;
  try {
    goesOn = await firstRun();
  } finally {
    if (!goesOn) stopWatching.abort();
    firstRunDone.resolve();
  }
  // A watch that has already failed is not watching: `await watching` rethrows its error.
  if (goesOn && !ended) onWatching();
  await watching;
};
