import {
  type Consistency,
  checkActor,
  checkConsistency,
  type DispatchOptions,
  errorFields,
  type HostRejectionReason,
  hostLogOf,
  type Logger,
  listTenantsUnderPreviousMaster,
  type Registry,
  resolveErrorText,
} from "@bounda-dev/core";
import type { Config } from "@bounda-dev/core/config";
import type { BoundaObjectMethods } from "./bounda-object.ts";
import type { BoundaStub } from "./client.ts";
import { cloudflareStorageOf } from "./definition.ts";
import { workersLogger } from "./logger.ts";
import { unwrap } from "./outcome.ts";
import { findBoundaNamespace } from "./tenant-stub.ts";
import { hostLogger } from "./witnesses.ts";

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
   * Durable Object's binding and whose `jurisdiction`, when it names one, holds every object.
   */
  readonly config: Config;
  /**
   * Which store a request belongs to: the name the object is addressed by. Every tenant is its
   * own object, with its own events and read models. An empty name answers a 500, logged, and
   * reaches no object. Called before the body is read, which it must leave unread.
   */
  readonly tenantOf: TenantOfFunction;
  /**
   * Who makes a request: the id of the user or service the request authenticates, which every
   * command and query it carries acts as (`BoundaClient.as`); `undefined` for nobody. Never a name
   * or an email: events keep it in the clear. Left out, requests act as nobody. Called before the
   * body is read, which it must leave unread.
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
  /**
   * The registry the objects run, whose `app/audit.ts` receives the host log: each request the
   * Worker refuses before an object serves it. Left out, or without `app/audit.ts`, the records go
   * to `logger`.
   */
  readonly registry?: Registry;
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
  TENANT_FORGOTTEN: 410,
  // A frozen tenant takes the same write again once its freeze is lifted.
  TENANT_FROZEN: 423,
  // What a restore found keeps from serving until it is settled: the same request succeeds then.
  READ_MODEL_RESTORING: 503,
  RESTORE_UNRECONCILED: 503,
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

// The id of an object reached without a name, which names its tenant then.
const OBJECT_ID = /^[0-9a-f]{64}$/;

// How many objects the schedule wakes at once.
const WAKE_BATCH = 50;

// A tenant's object: by its id when the name is one, else by its name, a name that only looks
// like an id included.
const objectIdOf = (namespace: DurableObjectNamespace, tenant: string): DurableObjectId => {
  if (OBJECT_ID.test(tenant)) {
    try {
      return namespace.idFromString(tenant);
    } catch {
      // A name of 64 hexadecimal digits: an id of no object of this namespace.
    }
  }
  return namespace.idFromName(tenant);
};

const route = (pathname: string): { readonly kind: string; readonly name: string } | null => {
  const match = /^\/(commands|queries)\/([A-Za-z][A-Za-z0-9]*)\/?$/.exec(pathname);
  return match === null ? null : { kind: match[1] as string, name: match[2] as string };
};

/**
 * A Worker that exposes one Bounda app as JSON over HTTP, a store per tenant, through the binding
 * and in the jurisdiction `cloudflare()` names, as `tenantStub` reaches it:
 *
 * - `POST /commands/<name>` with the payload as the body, `?delay=10m` to schedule it, answers
 *   the dispatch result, once the read models reflect it unless `consistency` is `"eventual"`;
 * - `POST /queries/<name>` with the payload as the body answers the query's result.
 *
 * Refusals come back as `{ error: { code, message } }`: 400 for a payload that fails validation,
 * with `issues`, 404 for an unknown command, query or row, 409 for a command's rejection, with its
 * code in `rejected`, for one refused because the person it touches is restricted, or for a
 * conflict, 410 once the tenant was forgotten, 413 for a body over `maxPayloadBytes`. Anything
 * else is a
 * 500 without its message, which is logged instead, as `BOUNDA_ERROR_TEXT` in the Worker's `env`
 * says, or else `runtime.telemetry.errorText`. Each request it refuses before an object serves
 * it, for a route it does not serve, a body it cannot read, a tenant `tenantOf` does not name or
 * an actor `actorOf` does not, is recorded first in the host log, the `onHostRejection` of
 * `registry`'s `app/audit.ts`. Its `scheduled`, run by a cron trigger, wakes every
 * object whose tenant's key is still under a previous master key, so a rotation of the master key
 * reaches the tenants whose objects sleep. There is no authentication and no operator
 * endpoint: it is a starting point, and an app with users writes its own `fetch` over `connect`. Throws `ConfigurationError` when `registry`'s `app/audit.ts` does not export `onHostRejection`, when
 * `storage` is not `cloudflare()` or for a `consistency` it does not know.
 */
export const createWorker: CreateWorkerFunction = ({
  config,
  tenantOf,
  actorOf,
  consistency = "read-your-writes",
  logger = workersLogger,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  registry,
}) => {
  const { binding } = cloudflareStorageOf(config).options;
  checkConsistency(consistency);
  // An app/audit.ts without onHostRejection is refused here, not at the first refusal.
  hostLogOf({ registry, env: {}, logger });
  // One namespace per `env` the Worker is handed, rather than one per request.
  const namespaces = new WeakMap<object, DurableObjectNamespace | undefined>();
  const namespaceOf = (env: object): DurableObjectNamespace | undefined => {
    if (!namespaces.has(env)) namespaces.set(env, findBoundaNamespace({ config, env }));
    return namespaces.get(env);
  };
  // Through the witness `witnessObjects` gives the Worker in a test.
  const log = (): Logger => hostLogger(worker, logger);
  const worker: ExportedHandler<Cloudflare.Env> = {
    // A rotation of the master key rewraps a tenant's key in the tenant's own object, the one
    // writer of its record: each one still under a previous master key is woken to do it.
    scheduled: async (_controller, env) => {
      const namespace = namespaceOf(env);
      if (namespace === undefined) {
        log().error("bounda worker has no such binding", { binding });
        return;
      }
      if (config.runtime?.personalData?.tenantKeys === undefined) return;
      const tenants = await listTenantsUnderPreviousMaster({ config, env });
      const errorText = resolveErrorText({ env, config, ignoreInvalidEnv: true });
      let failed = 0;
      for (let start = 0; start < tenants.length; start += WAKE_BATCH) {
        const batch = tenants.slice(start, start + WAKE_BATCH);
        const woken = await Promise.allSettled(
          batch.map((tenant) =>
            unwrap(
              (
                namespace.get(objectIdOf(namespace, tenant)) as unknown as Pick<
                  BoundaObjectMethods,
                  "wake"
                >
              ).wake(),
            ),
          ),
        );
        for (const [index, outcome] of woken.entries()) {
          if (outcome.status === "fulfilled") continue;
          failed += 1;
          log().error("bounda worker could not wake a tenant's object", {
            tenant: batch[index],
            ...errorFields({ error: outcome.reason, errorText }),
          });
        }
      }
      log().info(
        tenants.length === 0
          ? "bounda worker found no tenant left under a previous master key"
          : "bounda worker woke the tenants still under a previous master key",
        { tenants: tenants.length, failed },
      );
    },
    fetch: async (request, env) => {
      const url = new URL(request.url);
      const target = route(url.pathname);
      // Each refusal before an object serves the request, recorded before it goes out; what an
      // object refuses, it records itself.
      const refuse = (
        reason: HostRejectionReason,
        known: { readonly tenant?: string; readonly actor?: string | undefined } = {},
      ): Promise<void> =>
        hostLogOf({ registry, env, logger: log() })({
          tenant: known.tenant ?? null,
          reason,
          target: target === null ? null : `${target.kind}/${target.name}`,
          actor: known.actor ?? null,
        });
      const internal = (): Response => failure("INTERNAL", "Internal error", 500);
      try {
        if (target === null) {
          await refuse("no-route");
          return failure("NOT_FOUND", `No route for ${url.pathname}`, 404);
        }
        if (request.method !== "POST") {
          await refuse("method-not-allowed");
          return new Response(null, { status: 405, headers: { allow: "POST" } });
        }
        const namespace = namespaceOf(env);
        if (namespace === undefined) {
          log().error("bounda worker has no such binding", { binding });
          return internal();
        }
        let tenant: unknown;
        try {
          tenant = await tenantOf(request);
        } catch (error) {
          await refuse("tenant-unresolved");
          throw error;
        }
        // An empty name names no tenant: the object would refuse every start.
        if (typeof tenant !== "string" || tenant === "") {
          log().error("bounda worker tenantOf named no tenant", { path: url.pathname });
          await refuse("tenant-unresolved");
          return internal();
        }
        let actor: string | undefined;
        try {
          actor = await actorOf?.(request);
        } catch (error) {
          await refuse("actor-unresolved", { tenant });
          throw error;
        }
        if (actor !== undefined && !isActor(actor)) {
          // Not the caller's mistake, and the value may be what must not be logged, such as an email.
          log().error("bounda worker actorOf named no valid actor", { path: url.pathname });
          await refuse("actor-invalid", { tenant });
          return internal();
        }
        let payload: unknown;
        try {
          payload = await readPayload(request, maxPayloadBytes);
        } catch (error) {
          if (error instanceof PayloadTooLargeError) {
            await refuse("payload-too-large", { tenant, actor });
            return failure(error.code, error.message, STATUS_BY_CODE[error.code] as number);
          }
          await refuse("invalid-json", { tenant, actor });
          return failure("INVALID_JSON", "The body is not JSON", 400);
        }
        const stub = namespace.get(namespace.idFromName(tenant)) as unknown as BoundaStub;
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
        log().error("bounda worker request failed", {
          path: url.pathname,
          // The object refuses a `BOUNDA_ERROR_TEXT` it does not know, and the request fails with
          // that: logging the failure must not throw instead.
          ...errorFields({
            error,
            errorText: resolveErrorText({ env, config, ignoreInvalidEnv: true }),
          }),
        });
        return internal();
      }
    },
  };
  return worker;
};
