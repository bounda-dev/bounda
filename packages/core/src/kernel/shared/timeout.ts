import type { Clock } from "../../contracts/clock.ts";
import { BoundaError } from "../../contracts/errors.ts";

export class HandlerTimeoutError extends BoundaError {
  readonly timeoutMs: number;

  constructor(subject: string, timeoutMs: number) {
    super("HANDLER_TIMEOUT", `${subject} did not finish within ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}

export interface WithTimeoutArgs<T> {
  readonly run: () => Promise<T> | T;
  readonly timeoutMs: number;
  readonly subject: string;
  readonly clock: Clock;
  /**
   * Also loses the race when it aborts, rejecting with its reason; already aborted, `run` is never
   * called.
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * Called with the error before the race rejects with it, so the caller can abort what the
   * handler was given.
   */
  readonly onExpire?: (error: HandlerTimeoutError) => void;
}

export interface WithTimeoutFunction {
  <T>(args: WithTimeoutArgs<T>): Promise<T>;
}

/**
 * The handler keeps running if it loses. Its promise is awaited as soon as it exists, so a handler
 * that throws is never seen as an unhandled rejection, not even by runtimes such as workerd that
 * report one before a later `then` attaches.
 */
export const withTimeout: WithTimeoutFunction = async <T>({
  run,
  timeoutMs,
  subject,
  clock,
  signal,
  onExpire,
}: WithTimeoutArgs<T>): Promise<T> => {
  signal?.throwIfAborted();
  const lost = Promise.withResolvers<never>();
  const cancel = clock.after(timeoutMs, () => {
    const error = new HandlerTimeoutError(subject, timeoutMs);
    onExpire?.(error);
    lost.reject(error);
  });
  const abort = (): void => lost.reject(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const attempt = (async () => await run())();
    return await Promise.race([attempt, lost.promise]);
  } finally {
    cancel();
    signal?.removeEventListener("abort", abort);
  }
};
