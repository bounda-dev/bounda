import {
  type Consistency,
  checkActor,
  checkConsistency,
  type DispatchOptions,
  type Logger,
} from "@bounda-dev/core";
import type { Config } from "@bounda-dev/core/config";
import type { BoundaStub } from "./client.ts";
import { cloudflareStorageOf } from "./definition.ts";
import { workersLogger } from "./logger.ts";
import { unwrap } from "./outcome.ts";

export interface TenantOfFunction {
  (request: Request): string | Promise<string>;
}

/**
 * Names who makes a request, by the id the request authenticates, or `undefined` for nobody.
 */
export interface ActorOfFunction {
  (request: Request): string | undefined | Promise<string | undefined>;
}

export interface CreateWorkerArgs {
  /**
   * The app's configuration, with `storage: cloudflare()`, whose `binding` names the Bounda
   * Durable Object's binding.
   */
  readonly config: Config;
  /**
   * Which store a request belongs to: the name the object is addressed by. Every tenant is its
   * own object, with its own events and read models.
   */
  readonly tenantOf: TenantOfFunction;
  /**
   * Who makes a request: the id of the user or service the request authenticates, which every
   * command and query it carries acts as (`BoundaClient.as`); `undefined` for nobody. Never a name
   * or an email: events keep it in the clear. Left out, requests act as nobody.
   */
  readonly actorOf?: ActorOfFunction;
  /**
   * Whether a command answers once the read models reflect it, `"read-your-writes"` by default,
   * or as soon as its events are stored, `"eventual"`.
   */
  readonly consistency?: Consistency;
  /**
   * Defaults to one JSON line per entry on `console`, which Workers Logs parses into fields.
   */
  readonly logger?: Logger;
  /**
   * The largest body a request may carry, in bytes; a larger one is refused with a 413 before it
   * is read. Defaults to `DEFAULT_MAX_PAYLOAD_BYTES`.
   */
  readonly maxPayloadBytes?: number;
}

/**
 * The default of `createWorker`'s `maxPayloadBytes`: one mebibyte.
 */
export const DEFAULT_MAX_PAYLOAD_BYTES: number = 1_048_576;

export interface CreateWorkerFunction {
  (args: CreateWorkerArgs): ExportedHandler<Cloudflare.Env>;
}

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  VALIDATION_FAILED: 400,
  INVALID_JSON: 400,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  DOMAIN_ERROR: 409,
  PROCESSING_RESTRICTED: 409,
  CONCURRENCY_CONFLICT: 409,
  CHAIN_DEPTH_EXCEEDED: 409,
  HANDLER_TIMEOUT: 504,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const failure = (code: string, message: string, status: number, extra: object = {}): Response =>
  json({ error: { code, message, ...extra } }, status);

class PayloadTooLargeError extends Error {
  readonly code = "PAYLOAD_TOO_LARGE";

  constructor(maxBytes: number) {
    super(`The body is larger than ${maxBytes} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

// Read by chunks and given up as soon as the limit passes, so a body of any size costs the
// Worker at most `maxBytes` of memory; a declared length over it is refused before any read.
const readBody = async (request: Request, maxBytes: number): Promise<string> => {
  if (Number(request.headers.get("content-length")) > maxBytes) {
    throw new PayloadTooLargeError(maxBytes);
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(read.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const readPayload = async (request: Request, maxBytes: number): Promise<unknown> => {
  const text = await readBody(request, maxBytes);
  return text.trim() === "" ? undefined : JSON.parse(text);
};

const optionsOf = (url: URL): DispatchOptions => {
  const delay = url.searchParams.get("delay");
  const correlationId = url.searchParams.get("correlationId");
  return {
    ...(delay === null ? {} : { delay: delay as NonNullable<DispatchOptions["delay"]> }),
    ...(correlationId === null ? {} : { correlationId }),
  };
};

const isActor = (actor: unknown): boolean => {
  try {
    checkActor(actor);
  } catch {
    return false;
  }
  return true;
};

const route = (pathname: string): { readonly kind: string; readonly name: string } | null => {
  const match = /^\/(commands|queries)\/([A-Za-z][A-Za-z0-9]*)\/?$/.exec(pathname);
  return match === null ? null : { kind: match[1] as string, name: match[2] as string };
};

/**
 * A Worker that exposes one Bounda app as JSON over HTTP, a store per tenant, through the binding
 * `cloudflare()` names:
 *
 * - `POST /commands/<name>` with the payload as the body, `?delay=10m` to schedule it, answers
 *   the dispatch result, once the read models reflect it unless `consistency` is `"eventual"`;
 * - `POST /queries/<name>` with the payload as the body answers the query's result.
 *
 * Refusals come back as `{ error: { code, message } }`: 400 for a payload that fails validation,
 * with `issues`, 404 for an unknown command, query or row, 409 for a command's rejection, with its
 * code in `rejected`, for one refused because the person it touches is restricted, or for a
 * conflict, 413 for a body over `maxPayloadBytes`. Anything else is a
 * 500 without its message, which is logged instead. There is no authentication and no operator
 * endpoint: it is a starting point, and an app with users writes its own `fetch` over `connect`. Throws `ConfigurationError` when
 * `storage` is not `cloudflare()` or for a `consistency` it does not know.
 */
export const createWorker: CreateWorkerFunction = ({
  config,
  tenantOf,
  actorOf,
  consistency = "read-your-writes",
  logger = workersLogger,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
}) => {
  const { binding } = cloudflareStorageOf(config).options;
  checkConsistency(consistency);
  return {
    fetch: async (request, env) => {
      const url = new URL(request.url);
      const target = route(url.pathname);
      if (target === null) return failure("NOT_FOUND", `No route for ${url.pathname}`, 404);
      if (request.method !== "POST") {
        return new Response(null, { status: 405, headers: { allow: "POST" } });
      }
      let payload: unknown;
      try {
        payload = await readPayload(request, maxPayloadBytes);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          return failure(error.code, error.message, STATUS_BY_CODE[error.code] as number);
        }
        return failure("INVALID_JSON", "The body is not JSON", 400);
      }
      const namespace = Reflect.get(env, binding) as DurableObjectNamespace | undefined;
      if (namespace === undefined) {
        logger.error("bounda worker has no such binding", { binding });
        return failure("INTERNAL", "Internal error", 500);
      }
      try {
        const stub = namespace.get(
          namespace.idFromName(await tenantOf(request)),
        ) as unknown as BoundaStub;
        const actor = await actorOf?.(request);
        if (actor !== undefined && !isActor(actor)) {
          // Not the caller's mistake, and the value may be what must not be logged, such as an email.
          logger.error("bounda worker actorOf named no valid actor", { path: url.pathname });
          return failure("INTERNAL", "Internal error", 500);
        }
        const result = await unwrap(
          target.kind === "commands"
            ? stub.command(target.name, payload, optionsOf(url), consistency, actor)
            : stub.query(target.name, payload, actor),
        );
        return json(result ?? null);
      } catch (error) {
        const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
        const status = typeof code === "string" ? STATUS_BY_CODE[code] : undefined;
        if (typeof code === "string" && status !== undefined && error instanceof Error) {
          const issues = Reflect.get(error, "issues");
          const rejected = Reflect.get(error, "rejected");
          return failure(code, error.message, status, {
            ...(issues === undefined ? {} : { issues }),
            ...(typeof rejected === "string" ? { rejected } : {}),
          });
        }
        logger.error("bounda worker request failed", {
          path: url.pathname,
          message: error instanceof Error ? error.message : String(error),
        });
        return failure("INTERNAL", "Internal error", 500);
      }
    },
  };
};
