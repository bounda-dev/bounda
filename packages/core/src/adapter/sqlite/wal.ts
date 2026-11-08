/**
 * How long a statement on a SQLite file waits for another connection's lock before it fails with
 * `SQLITE_BUSY`, and how long switching a file to WAL keeps trying.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

const RETRY_DELAY_MS = { min: 5, max: 25 } as const;

export interface BusyRetryDelayFunction {
  (): number;
}

// Apart, so connections that collided do not collide again on the next try.
export const busyRetryDelay: BusyRetryDelayFunction = () =>
  RETRY_DELAY_MS.min + Math.random() * (RETRY_DELAY_MS.max - RETRY_DELAY_MS.min);

export interface PauseFunction {
  (ms: number): Promise<void>;
}

export const pause: PauseFunction = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SwitchToWalArgs {
  readonly execute: (sql: string) => Promise<unknown>;
  /**
   * Whether an error is the driver's `SQLITE_BUSY`.
   */
  readonly isBusy: (error: unknown) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface SwitchToWalFunction {
  (args: SwitchToWalArgs): Promise<void>;
}

/**
 * Switches a SQLite file to WAL, retrying for at most `SQLITE_BUSY_TIMEOUT_MS` while another
 * connection holds it. Use it on a connection that already has its busy timeout: connections
 * switching the same file at once can deadlock on their shared locks, and SQLite then fails one with
 * `SQLITE_BUSY` straight away instead of waiting. Rethrows any other error, and `SQLITE_BUSY` once
 * the time is up.
 */
export const switchToWal: SwitchToWalFunction = async ({
  execute,
  isBusy,
  sleep = pause,
  now = Date.now,
}) => {
  const deadline = now() + SQLITE_BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      await execute("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (!isBusy(error) || now() >= deadline) throw error;
      await sleep(busyRetryDelay());
    }
  }
};
