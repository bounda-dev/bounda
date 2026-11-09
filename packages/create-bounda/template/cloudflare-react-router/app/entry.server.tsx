import { handleError } from "@bounda-dev/react-router/app";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import { type EntryContext, ServerRouter } from "react-router";

// React Router's default entry for web streams, as a Worker runs it, with Bounda's handleError: it
// logs what a loader, an action or the render throws as BOUNDA_ERROR_TEXT, or else
// runtime.telemetry.errorText, says, where the default logs every message and stack, and a
// message may quote personal data.
export { handleError };

export const streamTimeout = 5_000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: responseStatusCode, headers: responseHeaders });
  }

  let status = responseStatusCode;
  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: AbortSignal.timeout(streamTimeout + 1000),
      onError(error: unknown) {
        status = 500;
        // An error before the shell rejects, and React Router hands it to handleError itself.
        if (shellRendered) void handleError(error, { request });
      },
    },
  );
  shellRendered = true;

  // Bots and SPA mode wait for all content before the response starts.
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, { headers: responseHeaders, status });
}
