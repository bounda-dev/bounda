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
  /**
   * Receives a signal that aborts when the race is lost, with the error it is lost to.
   */
  readonly run: (signal: AbortSignal) => Promise<T> | T;
  readonly timeoutMs: number;
  readonly subject: string;
  readonly clock: Clock;
  /**
   * Each also loses the race when it aborts, with its reason; one already aborted means `run` is
   * never called.
   */
  readonly signals?: readonly AbortSignal[];
}

export interface WithTimeoutFunction {
  <T>(args: WithTimeoutArgs<T>): Promise<T>;
}

/**
 * The handler keeps running if it loses. Its promise is awaited as soon as it exists, so a handler
 * that throws is never seen as an unhandled rejection, not even by runtimes such as workerd that
 * report one before a later `then` attaches. The race is lost before the handler's signal aborts:
 * a listener of that signal that throws, which older workerd compatibility dates rethrow from
 * `abort()`, cannot keep the race from settling. The signals are followed through listeners
 * removed at the end, never `AbortSignal.any`, which leaves a record on a long-lived source for
 * every call.
 */
export const withTimeout: WithTimeoutFunction = async <T>({
  run,
  timeoutMs,
  subject,
  clock,
  signals = [],
}: WithTimeoutArgs<T>): Promise<T> => {
  for (const signal of signals) signal.throwIfAborted();
  const controller = new AbortController();
  const lost = Promise.withResolvers<never>();
  const lose = (reason: unknown): void => {
    lost.reject(reason);
    controller.abort(reason);
  };
  const cancel = clock.after(timeoutMs, () => lose(new HandlerTimeoutError(subject, timeoutMs)));
  const follows = signals.map((signal) => {
    const follow = (): void => lose(signal.reason);
    signal.addEventListener("abort", follow);
    return () => signal.removeEventListener("abort", follow);
  });
  try {
    const attempt = (async () => await run(controller.signal))();
    return await Promise.race([attempt, lost.promise]);
  } finally {
    cancel();
    for (const unfollow of follows) unfollow();
  }
};
