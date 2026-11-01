import {
  type BoundaClient,
  type DispatchOptions,
  idempotencyKeyFor,
  type Registry,
} from "@bounda-dev/core";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_KEY_FIELD = "idempotencyKey";

const FORM = /^(application\/x-www-form-urlencoded|multipart\/form-data)\b/i;

export interface IdempotencyKeyOfFunction {
  (request: Request): Promise<string | null>;
}

// The request's `Idempotency-Key` header or, without one, the `idempotencyKey` field of the form
// it posts, since a browser form sends no headers. The form is read from a clone, so the action
// still reads the body; any other body is never cloned, since a clone keeps a copy of it in
// memory. A body already read, or one that does not parse, yields no key: the action meets the
// error itself.
export const idempotencyKeyOf: IdempotencyKeyOfFunction = async (request) => {
  const header = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (header !== null) return header;
  if (!FORM.test(request.headers.get("Content-Type") ?? "")) return null;
  try {
    const field = (await request.clone().formData()).get(IDEMPOTENCY_KEY_FIELD);
    return typeof field === "string" ? field : null;
  } catch {
    return null;
  }
};

export interface WithIdempotencyKeyFunction {
  <R extends Registry>(client: BoundaClient<R>, request: Request): Promise<BoundaClient<R>>;
}

// The client whose commands carry a key derived from the request's key (`idempotencyKeyOf`) and
// the command's name as their `idempotencyKey`, unless the caller passes one of its own, so an
// action that dispatches two commands records each under its own key; the client as it is for a
// request without a key. An empty key is passed on as it is, for the dispatch to refuse.
export const withIdempotencyKey: WithIdempotencyKeyFunction = async <R extends Registry>(
  client: BoundaClient<R>,
  request: Request,
): Promise<BoundaClient<R>> => {
  const key = await idempotencyKeyOf(request);
  if (key === null) return client;
  // A proxy rather than a copy: on Cloudflare the commands are a proxy with no keys to copy.
  const commands = new Proxy(client.commands as object, {
    get: (target, name, receiver) => {
      const member: unknown = Reflect.get(target, name, receiver);
      if (typeof member !== "function") return member;
      const idempotencyKey = key === "" ? key : idempotencyKeyFor(key, String(name));
      return (payload?: unknown, options?: DispatchOptions) =>
        Reflect.apply(member, target, [
          payload,
          { ...options, idempotencyKey: options?.idempotencyKey ?? idempotencyKey },
        ]);
    },
  }) as BoundaClient<R>["commands"];
  return { ...client, commands };
};
