import { BoundaError } from "../../contracts/errors.ts";

/**
 * Thrown when a handler exceeds its configured timeout.
 */
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
}

export interface WithTimeoutFunction {
  <T>(args: WithTimeoutArgs<T>): Promise<T>;
}

/**
 * Races a handler against a timer. The handler keeps running if it loses; the runner treats the
 * timeout as a retriable failure. The handler's promise is awaited as soon as it exists, so a
 * handler that throws is never seen as an unhandled rejection, not even by runtimes such as
 * workerd that report one before a later `then` attaches.
 */
export const withTimeout: WithTimeoutFunction = async <T>({
  run,
  timeoutMs,
  subject,
}: WithTimeoutArgs<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HandlerTimeoutError(subject, timeoutMs)), timeoutMs);
  });
  try {
    const attempt = (async () => await run())();
    return await Promise.race([attempt, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
