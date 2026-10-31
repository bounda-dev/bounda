import { type BoundaClient, type DispatchOptions, idempotencyKeyFor } from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_HEADER, withIdempotencyKey } from "./idempotency-key.ts";

const request = (idempotencyKey?: string) =>
  new Request("http://localhost/", {
    headers: idempotencyKey === undefined ? {} : { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
  });

const recording = () => {
  const calls: unknown[][] = [];
  const client = {
    commands: {
      placeOrder: async (payload?: unknown, options?: DispatchOptions) => {
        calls.push([payload, options]);
        return { scheduled: false };
      },
      kind: "facade",
    },
    queries: { getOrder: async () => null },
  } as unknown as BoundaClient;
  return { client, calls };
};

describe("withIdempotencyKey", () => {
  it("hands every command a key of its own from the header, unless the caller passes one", async () => {
    const { client, calls } = recording();
    const served = withIdempotencyKey(client, request("req-1"));
    expect(served).not.toBe(client);
    expect(served.queries).toBe(client.queries);
    const commands = served.commands as unknown as Record<string, unknown>;
    expect(commands.kind).toBe("facade");
    const placeOrder = commands.placeOrder as (
      payload?: unknown,
      options?: DispatchOptions,
    ) => Promise<unknown>;
    await placeOrder({ orderId: "o-1" });
    await placeOrder({ orderId: "o-1" }, { correlationId: "c-1" });
    await placeOrder({ orderId: "o-1" }, { idempotencyKey: "mine" });
    await placeOrder({ orderId: "o-1" }, {
      idempotencyKey: undefined,
    } as unknown as DispatchOptions);
    const placed = idempotencyKeyFor("req-1", "placeOrder");
    expect(calls).toEqual([
      [{ orderId: "o-1" }, { idempotencyKey: placed }],
      [{ orderId: "o-1" }, { correlationId: "c-1", idempotencyKey: placed }],
      [{ orderId: "o-1" }, { idempotencyKey: "mine" }],
      [{ orderId: "o-1" }, { idempotencyKey: placed }],
    ]);
  });

  it("keys two commands of one request apart, and one command alike on every request", async () => {
    const calls: unknown[][] = [];
    const client = {
      commands: {
        reserveSeats: async (_payload?: unknown, options?: DispatchOptions) =>
          calls.push(["reserveSeats", options?.idempotencyKey]),
        placeOrder: async (_payload?: unknown, options?: DispatchOptions) =>
          calls.push(["placeOrder", options?.idempotencyKey]),
      },
    } as unknown as BoundaClient;
    for (const attempt of [1, 2]) {
      const commands = withIdempotencyKey(client, request("req-3")).commands as unknown as Record<
        string,
        (payload: unknown) => Promise<unknown>
      >;
      await commands.reserveSeats?.({ attempt });
      await commands.placeOrder?.({ attempt });
    }
    const [reserve, place] = calls.map(([, key]) => key);
    expect(reserve).not.toBe(place);
    expect(calls).toEqual([
      ["reserveSeats", reserve],
      ["placeOrder", place],
      ["reserveSeats", reserve],
      ["placeOrder", place],
    ]);
  });

  it("leaves a client alone whose request has no header, and passes an empty header on", async () => {
    const { client, calls } = recording();
    expect(withIdempotencyKey(client, request())).toBe(client);
    const served = withIdempotencyKey(client, request(""));
    await (
      served.commands as unknown as { placeOrder: (payload: unknown) => Promise<unknown> }
    ).placeOrder({});
    expect(calls).toEqual([[{}, { idempotencyKey: "" }]]);
  });

  it("works on commands that are a proxy, as a Durable Object's client has", async () => {
    const calls: unknown[][] = [];
    const client = {
      commands: new Proxy(
        {},
        {
          get: (_target, key) =>
            typeof key === "string" && key !== "then"
              ? async (...args: unknown[]) => calls.push([key, ...args])
              : undefined,
        },
      ),
    } as unknown as BoundaClient;
    const served = withIdempotencyKey(client, request("req-2"));
    await (
      served.commands as unknown as Record<string, (payload: unknown) => Promise<unknown>>
    ).anything?.({ id: "1" });
    expect(calls).toEqual([
      ["anything", { id: "1" }, { idempotencyKey: idempotencyKeyFor("req-2", "anything") }],
    ]);
    expect((served.commands as unknown as { then?: unknown }).then).toBeUndefined();
  });
});
