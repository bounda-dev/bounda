import type { DispatchOptions, Logger } from "@bounda-dev/core";
import type { BoundaStub } from "./client.ts";
import { workersLogger } from "./logger.ts";

export interface TenantOfFunction {
  (request: Request): string | Promise<string>;
}

export interface CreateWorkerArgs {
  /**
   * The name of the Bounda Durable Object's binding in `wrangler.jsonc`.
   */
  readonly binding: string;
  /**
   * Which store a request belongs to: the name the object is addressed by. Defaults to the
   * `x-bounda-tenant` header, or `default` without one. Every tenant is its own object, with its
   * own events and read models.
   */
  readonly tenantOf?: TenantOfFunction;
  readonly logger?: Logger;
}

export interface CreateWorkerFunction {
  (args: CreateWorkerArgs): ExportedHandler<Cloudflare.Env>;
}

/**
 * The header `createWorker` reads the tenant from by default.
 */
export const TENANT_HEADER: "x-bounda-tenant" = "x-bounda-tenant";

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  VALIDATION_FAILED: 400,
  INVALID_JSON: 400,
  NOT_FOUND: 404,
  DOMAIN_ERROR: 409,
  CONCURRENCY_CONFLICT: 409,
  CHAIN_DEPTH_EXCEEDED: 409,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const failure = (code: string, message: string, status: number, extra: object = {}): Response =>
  json({ error: { code, message, ...extra } }, status);

const defaultTenant: TenantOfFunction = (request) =>
  request.headers.get(TENANT_HEADER) ?? "default";

const readPayload = async (request: Request): Promise<unknown> => {
  const text = await request.text();
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

const route = (pathname: string): { readonly kind: string; readonly name: string } | null => {
  const match = /^\/(commands|queries)\/([A-Za-z][A-Za-z0-9]*)\/?$/.exec(pathname);
  return match === null ? null : { kind: match[1] as string, name: match[2] as string };
};

/**
 * A Worker that exposes one Bounda app as JSON over HTTP, a store per tenant:
 *
 * - `POST /commands/<name>` with the payload as the body, `?delay=10m` to schedule it, answers
 *   the dispatch result once the read models reflect it;
 * - `POST /queries/<name>` with the payload as the body answers the query's result.
 *
 * Refusals come back as `{ error: { code, message } }`: 400 for a payload that fails validation,
 * 404 for an unknown command, query or row, 409 for a domain rule or a conflict. Anything else is
 * a 500 without its message, which is logged instead. There is no authentication and no operator
 * endpoint: it is a starting point, and an app with users writes its own `fetch` over `connect`.
 */
export const createWorker: CreateWorkerFunction = ({
  binding,
  tenantOf = defaultTenant,
  logger = workersLogger,
}) => ({
  fetch: async (request, env) => {
    const url = new URL(request.url);
    const target = route(url.pathname);
    if (target === null) return failure("NOT_FOUND", `No route for ${url.pathname}`, 404);
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    let payload: unknown;
    try {
      payload = await readPayload(request);
    } catch {
      return failure("INVALID_JSON", "The body is not JSON", 400);
    }
    const namespace = Reflect.get(env, binding) as DurableObjectNamespace | undefined;
    if (namespace === undefined) {
      logger.error("bounda worker has no such binding", { binding });
      return failure("INTERNAL", "Internal error", 500);
    }
    const stub = namespace.get(
      namespace.idFromName(await tenantOf(request)),
    ) as unknown as BoundaStub;
    try {
      const result =
        target.kind === "commands"
          ? await stub.command(target.name, payload, optionsOf(url))
          : await stub.query(target.name, payload);
      return json(result ?? null);
    } catch (error) {
      const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
      const status = typeof code === "string" ? STATUS_BY_CODE[code] : undefined;
      if (typeof code === "string" && status !== undefined && error instanceof Error) {
        const issues = Reflect.get(error, "issues");
        return failure(code, error.message, status, issues === undefined ? {} : { issues });
      }
      logger.error("bounda worker request failed", {
        path: url.pathname,
        message: error instanceof Error ? error.message : String(error),
      });
      return failure("INTERNAL", "Internal error", 500);
    }
  },
});
