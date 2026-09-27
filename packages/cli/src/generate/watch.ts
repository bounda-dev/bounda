import { rm, watch as watchDirectory, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Clock, systemClock } from "@bounda-dev/core";

/**
 * `fs.watch` from `node:fs/promises`, or a stand-in for tests.
 */
export type WatchFunction = typeof watchDirectory;

export interface WatchProjectArgs {
  readonly root: string;
  /**
   * The application directory under `root`. Defaults to `app`.
   */
  readonly appDir?: string;
  /**
   * Called after every burst of changes, once the debounce window has passed. Its rejection is
   * passed to `onError`; watching goes on.
   */
  readonly onChange: () => Promise<void>;
  readonly onError?: (error: unknown) => void;
  /**
   * Called once the watcher is known to be listening: a change made from then on is seen.
   */
  readonly onListening?: () => void;
  /**
   * Quiet time after the last change before `onChange` runs. Defaults to 100 ms.
   */
  readonly debounceMs?: number;
  /**
   * What the quiet time, and the wait before the cookie is written again, are measured on.
   * Defaults to the wall clock.
   */
  readonly clock?: Clock;
  /**
   * Aborting it ends the watch.
   */
  readonly signal: AbortSignal;
  readonly watch?: WatchFunction;
}

export interface WatchProjectFunction {
  (args: WatchProjectArgs): Promise<void>;
}

const COOKIE_RETRY_MS = 50;

let cookies = 0;

const isGenerated = (fileName: string | Buffer | null): boolean =>
  typeof fileName === "string" && fileName.split(/[\\/]/).includes("+types");

/**
 * Watches the application directory and regenerates after each burst of changes to user modules.
 * Changes under `+types` are the generator's own and are ignored. The operating system may start
 * listening some time after the watch is set up, and miss what changes before (FSEvents on macOS
 * does), so the watch writes a cookie file, `.bounda-watch-<pid>-<n>`, into the directory until
 * it hears it back, removes it and calls `onListening`: a change made from then on is seen. The
 * cookie's own changes are ignored. Resolves when the signal aborts; rejects when the watcher, or
 * writing the cookie, fails.
 */
export const watchProject: WatchProjectFunction = async ({
  root,
  appDir = "app",
  onChange,
  onError = () => undefined,
  onListening = () => undefined,
  debounceMs = 100,
  clock = systemClock,
  signal,
  watch = watchDirectory,
}) => {
  const directory = join(root, appDir);
  const cookie = `.bounda-watch-${process.pid}-${cookies++}`;
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
  const listen = async (): Promise<void> => {
    const path = join(directory, cookie);
    try {
      let outcome: unknown;
      do {
        await writeFile(path, "");
        const retry = Promise.withResolvers<"retry">();
        const cancelRetry = clock.after(COOKIE_RETRY_MS, () => retry.resolve("retry"));
        outcome = await Promise.race([heard.promise, ended.promise, retry.promise]);
        cancelRetry();
      } while (outcome === "retry");
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
      () => {
        if (!over) onListening();
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
   * Started once the watcher is listening, or once the watch has ended without listening.
   * Resolves to whether watching goes on; a rejection ends the watch and is rethrown.
   */
  readonly firstRun: () => Promise<boolean>;
  /**
   * Called once the first run has resolved to go on.
   */
  readonly onWatching: () => void;
}

export interface WatchFromFirstRunFunction {
  (args: WatchFromFirstRunArgs): Promise<void>;
}

/**
 * Starts watching and makes the first run once the watcher is listening, so a change made while
 * that run is going is not lost: it waits for the run to finish and then goes to `onChange`. Ends
 * at once, dropping a change held back, when the first run does not go on, and otherwise when the
 * signal aborts.
 */
export const watchFromFirstRun: WatchFromFirstRunFunction = async ({
  firstRun,
  onWatching,
  onChange,
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
    onChange: async () => {
      await firstRunDone.promise;
      if (!watchSignal.aborted) await onChange();
    },
  });
  const watchEnded = watching.then(
    () => undefined,
    () => undefined,
  );
  await Promise.race([listening.promise, watchEnded]);
  let goesOn = false;
  try {
    goesOn = await firstRun();
  } finally {
    if (!goesOn) stopWatching.abort();
    firstRunDone.resolve();
  }
  if (goesOn) onWatching();
  await watching;
};
