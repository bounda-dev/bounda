import { errorFields, type Logger } from "@bounda-dev/core";
import type { ErrorText } from "@bounda-dev/core/config";
import { isRouteErrorResponse } from "react-router";

/**
 * React Router's `handleError`, to export from `app/entry.server.tsx`, and to call from its
 * streaming render's `onError`: logs what a loader, an action or the render throws as
 * `runtime.telemetry.errorText` says, its class and its `code`, plus its message, its stack and
 * the request's path only with `"include"`, where React Router's default logs the message and the
 * stack always, and an error's message may quote personal data. It skips a request the client
 * aborted, as the default does. Resolves once the line is logged, and never rejects.
 */
export interface HandleBoundaErrorFunction {
  (error: unknown, args: { readonly request: Request }): Promise<void>;
}

export interface CreateHandleErrorArgs {
  readonly message: string;
  /**
   * `"omit"` stands in when it throws, as before an app has booted with a configuration.
   */
  readonly errorText: () => ErrorText | Promise<ErrorText>;
  readonly logger: () => Logger | Promise<Logger>;
}

export interface CreateHandleErrorFunction {
  (args: CreateHandleErrorArgs): HandleBoundaErrorFunction;
}

// React Router wraps what it throws itself, such as no route matching, with the error inside.
const unwrapped = (error: unknown): unknown =>
  isRouteErrorResponse(error) && Reflect.get(error, "error") instanceof Error
    ? Reflect.get(error, "error")
    : error;

export const createHandleError: CreateHandleErrorFunction =
  ({ message, errorText, logger }) =>
  async (error, { request }) => {
    if (request.signal.aborted) return;
    const text = await Promise.resolve()
      .then(errorText)
      .catch((): ErrorText => "omit");
    try {
      (await logger()).error(message, {
        method: request.method,
        ...(text === "include" ? { path: new URL(request.url).pathname } : {}),
        ...errorFields({ error: unwrapped(error), errorText: text }),
      });
    } catch {
      // A logger that fails has nowhere left to report it, and React Router must not see it throw.
    }
  };
