import {
  type BoundaClient,
  type DispatchOptions,
  idempotencyKeyFor,
  type Registry,
} from "@bounda-dev/core";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

export interface WithIdempotencyKeyFunction {
  <R extends Registry>(client: BoundaClient<R>, request: Request): BoundaClient<R>;
}

// The client whose commands carry a key derived from the request's `Idempotency-Key` header and
// the command's name as their `idempotencyKey`, unless the caller passes one of its own, so an
// action that dispatches two commands records each under its own key; the client as it is for a
// request without the header. An empty header is passed on as it is, for the dispatch to refuse.
export const withIdempotencyKey: WithIdempotencyKeyFunction = <R extends Registry>(
  client: BoundaClient<R>,
  request: Request,
): BoundaClient<R> => {
  const header = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (header === null) return client;
  // A proxy rather than a copy: on Cloudflare the commands are a proxy with no keys to copy.
  const commands = new Proxy(client.commands as object, {
    get: (target, key, receiver) => {
      const member: unknown = Reflect.get(target, key, receiver);
      if (typeof member !== "function") return member;
      const idempotencyKey = header === "" ? header : idempotencyKeyFor(header, String(key));
      return (payload?: unknown, options?: DispatchOptions) =>
        Reflect.apply(member, target, [
          payload,
          { ...options, idempotencyKey: options?.idempotencyKey ?? idempotencyKey },
        ]);
    },
  }) as BoundaClient<R>["commands"];
  return { ...client, commands };
};
