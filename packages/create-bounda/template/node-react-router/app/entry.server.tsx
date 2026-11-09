import { PassThrough } from "node:stream";
import { handleError } from "@bounda-dev/react-router/app";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { type RenderToPipeableStreamOptions, renderToPipeableStream } from "react-dom/server";
import { type EntryContext, ServerRouter } from "react-router";

// React Router's default entry for Node, with Bounda's handleError: it logs what a loader, an
// action or the render throws as runtime.telemetry.errorText says, where the default logs every
// message and stack, and a message may quote personal data.
export { handleError };

export const streamTimeout = 5_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: responseStatusCode, headers: responseHeaders });
  }

  return new Promise<Response>((resolve, reject) => {
    let status = responseStatusCode;
    let shellRendered = false;
    const userAgent = request.headers.get("user-agent");

    // Bots and SPA mode wait for all content before the response starts.
    const readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode ? "onAllReady" : "onShellReady";

    // Aborts the render after streamTimeout, leaving it time to flush the rejected boundaries.
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => abort(),
      streamTimeout + 1000,
    );

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              clearTimeout(timeoutId);
              timeoutId = undefined;
              callback();
            },
          });
          const stream = createReadableStreamFromReadable(body);
          responseHeaders.set("Content-Type", "text/html");
          pipe(body);
          resolve(new Response(stream, { headers: responseHeaders, status }));
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          status = 500;
          // An error before the shell rejects, and React Router hands it to handleError itself.
          if (shellRendered) void handleError(error, { request });
        },
      },
    );
  });
}
