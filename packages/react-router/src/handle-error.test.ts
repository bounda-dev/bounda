import { inspect } from "node:util";
import type { BoundaApp, Logger } from "@bounda-dev/core";
import type { ErrorText } from "@bounda-dev/core/config";
import {
  createRequestHandler,
  type HandleErrorFunction,
  type ServerBuild,
  UNSAFE_ErrorResponseImpl,
} from "react-router";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createBounda } from "./create-bounda.ts";
import { createHandleError, type HandleBoundaErrorFunction } from "./handle-error.ts";

const recording = () => {
  const lines: unknown[][] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (...entry) => void lines.push(entry),
  };
  return { lines, logger };
};

const request = () => new Request("http://localhost/accounts/ana@example.com?step=2");

const quoting = () => new Error("no account for ana@example.com");

let keys = 0;
const uniqueKey = (): string => `bounda.handle-error.${process.pid}.${++keys}`;

const appWith = (errorText: ErrorText): BoundaApp =>
  ({
    config: { runtime: { telemetry: { errorText } } },
    start: () => undefined,
    stop: async () => undefined,
    catchUpReadModels: async () => undefined,
    commands: {},
  }) as unknown as BoundaApp;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createHandleError", () => {
  it("logs an error's class and code alone with omit, and its text and the path with include", async () => {
    const omitted = recording();
    await createHandleError({
      message: "request failed",
      errorText: () => "omit",
      logger: () => omitted.logger,
    })(quoting(), { request: request() });
    expect(omitted.lines).toEqual([["request failed", { method: "GET", errorName: "Error" }]]);

    const included = recording();
    await createHandleError({
      message: "request failed",
      errorText: async (): Promise<ErrorText> => "include",
      logger: async () => included.logger,
    })(quoting(), { request: request() });
    expect(included.lines).toEqual([
      [
        "request failed",
        {
          method: "GET",
          path: "/accounts/ana@example.com",
          errorName: "Error",
          errorMessage: "no account for ana@example.com",
          errorStack: expect.stringContaining("no account for ana@example.com"),
        },
      ],
    ]);
  });

  it("logs the error React Router wraps in what it throws itself, and the wrapper without one", async () => {
    const { lines, logger } = recording();
    const handleError = createHandleError({
      message: "request failed",
      errorText: () => "omit",
      logger: () => logger,
    });
    await handleError(
      new UNSAFE_ErrorResponseImpl(
        404,
        "Not Found",
        new TypeError('No route matches "/ana"'),
        true,
      ),
      { request: request() },
    );
    await handleError(new UNSAFE_ErrorResponseImpl(404, "Not Found", "ana"), {
      request: request(),
    });
    expect(lines).toEqual([
      ["request failed", { method: "GET", errorName: "TypeError" }],
      ["request failed", { method: "GET", errorName: "object" }],
    ]);
  });

  it("logs nothing for a request the client aborted", async () => {
    const { lines, logger } = recording();
    const controller = new AbortController();
    controller.abort();
    await createHandleError({
      message: "request failed",
      errorText: () => "include",
      logger: () => logger,
    })(quoting(), { request: new Request("http://localhost/", { signal: controller.signal }) });
    expect(lines).toEqual([]);
  });

  it("omits the text when the rule cannot be read, and never rejects", async () => {
    const { lines, logger } = recording();
    await createHandleError({
      message: "request failed",
      errorText: () => {
        throw new Error("no configuration");
      },
      logger: () => logger,
    })(quoting(), { request: request() });
    expect(lines).toEqual([["request failed", { method: "GET", errorName: "Error" }]]);
    await expect(
      createHandleError({
        message: "request failed",
        errorText: () => "include",
        logger: () => ({
          ...logger,
          error: () => {
            throw new Error("full disk");
          },
        }),
      })(quoting(), { request: request() }),
    ).resolves.toBeUndefined();
    await expect(
      createHandleError({
        message: "request failed",
        errorText: () => "include",
        logger: () => Promise.reject(new Error("no logger")),
      })(quoting(), { request: request() }),
    ).resolves.toBeUndefined();
  });

  it("is a handleError React Router accepts", () => {
    expectTypeOf<HandleBoundaErrorFunction>().toExtend<HandleErrorFunction>();
  });
});

// A server build whose root route mounts the middleware and whose loader rethrows what it caught,
// served by React Router's own request handler, as `react-router-serve` and a Worker do.
const serverBuild = (
  bounda: ReturnType<typeof createBounda>,
  withHandleError: boolean,
): ServerBuild =>
  ({
    entry: {
      module: {
        default: (_request: Request, status: number) => new Response("document", { status }),
        ...(withHandleError ? { handleError: bounda.handleError } : {}),
      },
    },
    routes: {
      root: {
        id: "root",
        path: "",
        module: { default: () => null, middleware: [bounda.boundaMiddleware] },
      },
      account: {
        id: "account",
        parentId: "root",
        path: "accounts/:email",
        module: {
          default: () => null,
          loader: () => {
            try {
              throw quoting();
            } catch (error) {
              throw new Error(`could not load: ${(error as Error).message}`, { cause: error });
            }
          },
        },
      },
    },
    assets: { entry: { imports: [], module: "" }, routes: {}, url: "", version: "1" },
    publicPath: "/",
    assetsBuildDirectory: "",
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" },
  }) as unknown as ServerBuild;

// What the console would print: an error with its message, stack and cause, not `{}`.
const shown = (value: unknown): string => (typeof value === "string" ? value : inspect(value));

const served = async (errorText: ErrorText, withHandleError = true) => {
  const console_: unknown[][] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args) => void console_.push(args.map(shown)));
  }
  const { lines, logger } = recording();
  const bounda = createBounda({ boot: async () => appWith(errorText), key: uniqueKey(), logger });
  const handler = createRequestHandler(serverBuild(bounda, withHandleError), "production");
  const response = await handler(request());
  if (withHandleError) await vi.waitFor(() => expect(lines).toHaveLength(1));
  await bounda.dispose();
  return { response, logged: JSON.stringify([lines, console_]), lines };
};

describe("handleError behind React Router's request handler", () => {
  it("is needed: React Router's default logs the message of what a loader rethrows", async () => {
    const { logged } = await served("omit", false);
    expect(logged).toContain("could not load: no account for ana@example.com");
  });

  it("keeps the message and the stack of what a loader rethrows out of every log with omit", async () => {
    const { response, logged, lines } = await served("omit");
    expect(response.status).toBe(500);
    expect(logged).not.toContain("ana@example.com");
    expect(logged).not.toContain("could not load");
    expect(lines).toEqual([["request failed", { method: "GET", errorName: "Error" }]]);
  });

  it("logs them with include", async () => {
    const { response, logged, lines } = await served("include");
    expect(response.status).toBe(500);
    expect(logged).toContain("could not load: no account for ana@example.com");
    expect(lines).toEqual([
      [
        "request failed",
        {
          method: "GET",
          path: "/accounts/ana@example.com",
          errorName: "Error",
          errorMessage: "could not load: no account for ana@example.com",
          errorStack: expect.stringContaining("at "),
        },
      ],
    ]);
  });
});
