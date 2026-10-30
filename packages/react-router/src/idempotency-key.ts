import type { BoundaClient, DispatchOptions, Registry } from "@bounda-dev/core";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

export interface WithIdempotencyKeyFunction {
  <R extends Registry>(client: BoundaClient<R>, request: Request): BoundaClient<R>;
}

// The client whose commands carry the request's `Idempotency-Key` header as their
// `idempotencyKey`, unless the caller passes one of its own; the client as it is for a request
// without the header.
export const withIdempotencyKey: WithIdempotencyKeyFunction = <R extends Registry>(
  client: BoundaClient<R>,
  request: Request,
): BoundaClient<R> => {
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (idempotencyKey === null) return client;
  // A proxy rather than a copy: on Cloudflare the commands are a proxy with no keys to copy.
  const commands = new Proxy(client.commands as object, {
    get: (target, key, receiver) => {
      const member: unknown = Reflect.get(target, key, receiver);
      if (typeof member !== "function") return member;
      return (payload?: unknown, options?: DispatchOptions) =>
        Reflect.apply(member, target, [
          payload,
          { ...options, idempotencyKey: options?.idempotencyKey ?? idempotencyKey },
        ]);
    },
  }) as BoundaClient<R>["commands"];
  return { ...client, commands };
};
