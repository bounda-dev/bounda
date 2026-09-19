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
 * timeout as a retriable failure.
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
    return await Promise.race([Promise.resolve().then(run), expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
