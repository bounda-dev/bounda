import { watch as watchDirectory } from "node:fs/promises";
import { join } from "node:path";

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
   * Quiet time after the last change before `onChange` runs. Defaults to 100 ms.
   */
  readonly debounceMs?: number;
  /**
   * Aborting it ends the watch.
   */
  readonly signal: AbortSignal;
  readonly watch?: WatchFunction;
}

export interface WatchProjectFunction {
  (args: WatchProjectArgs): Promise<void>;
}

const isGenerated = (fileName: string | Buffer | null): boolean =>
  typeof fileName === "string" && fileName.split(/[\\/]/).includes("+types");

/**
 * Watches the application directory and regenerates after each burst of changes to user modules.
 * Changes under `+types` are the generator's own and are ignored. Resolves when the signal aborts.
 */
export const watchProject: WatchProjectFunction = async ({
  root,
  appDir = "app",
  onChange,
  onError = () => undefined,
  debounceMs = 100,
  signal,
  watch = watchDirectory,
}) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      running = running.then(onChange).catch(onError);
    }, debounceMs);
  };
  try {
    for await (const event of watch(join(root, appDir), { recursive: true, signal })) {
      if (!isGenerated(event.filename)) schedule();
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await running;
  }
};
