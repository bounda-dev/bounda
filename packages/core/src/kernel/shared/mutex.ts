export interface Mutex {
  /**
   * Runs `task` once every previously scheduled task has finished. Tasks never overlap.
   */
  run<T>(task: () => Promise<T>): Promise<T>;
  /**
   * Resolves once every task scheduled so far has finished.
   */
  drain(): Promise<void>;
}

export interface CreateMutexFunction {
  (): Mutex;
}

/**
 * A promise-chain mutex. The dispatcher uses one so polling and `processUntilIdle` can never run
 * a pass at the same time.
 */
export const createMutex: CreateMutexFunction = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run: (task) => {
      const next = tail.then(task, task);
      tail = next.catch(() => undefined);
      return next;
    },
    drain: async () => {
      await tail;
    },
  };
};
