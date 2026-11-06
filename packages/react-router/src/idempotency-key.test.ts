import { type BoundaClient, type DispatchOptions, idempotencyKeyFor } from "@bounda-dev/core";
import { describe, expect, it, vi } from "vitest";
import {
  IDEMPOTENCY_KEY_FIELD,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeyOf,
  MAX_FORM_BYTES,
  withIdempotencyKey,
} from "./idempotency-key.ts";

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

const posted = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://localhost/", { method: "POST", body, headers });

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
};

describe("idempotencyKeyOf", () => {
  it("reads the field of a form posted urlencoded or multipart, and leaves the body to the action", async () => {
    const urlencoded = posted(new URLSearchParams({ [IDEMPOTENCY_KEY_FIELD]: "k-1", name: "Ada" }));
    expect(await idempotencyKeyOf(urlencoded)).toBe("k-1");
    expect((await urlencoded.formData()).get("name")).toBe("Ada");

    const multipart = posted(form({ [IDEMPOTENCY_KEY_FIELD]: "k-2", name: "Ada" }));
    expect(multipart.headers.get("Content-Type")).toMatch(/^multipart\/form-data/);
    expect(await idempotencyKeyOf(multipart)).toBe("k-2");
    expect((await multipart.formData()).get("name")).toBe("Ada");
  });

  it("prefers the header to the field, and reads no body when the header is there", async () => {
    const both = posted(new URLSearchParams({ [IDEMPOTENCY_KEY_FIELD]: "field" }), {
      [IDEMPOTENCY_KEY_HEADER]: "header",
    });
    expect(await idempotencyKeyOf(both)).toBe("header");
    expect(both.bodyUsed).toBe(false);
  });

  it("passes an empty field on as it is", async () => {
    expect(
      await idempotencyKeyOf(posted(new URLSearchParams({ [IDEMPOTENCY_KEY_FIELD]: "" }))),
    ).toBe("");
  });

  it("finds no key in a GET, nor in a body without the field or that is no form, which it never copies", async () => {
    const get = request();
    const json = posted(JSON.stringify({ [IDEMPOTENCY_KEY_FIELD]: "k" }), {
      "Content-Type": "application/json",
    });
    const clones = [vi.spyOn(get, "clone"), vi.spyOn(json, "clone")];
    expect(await idempotencyKeyOf(get)).toBeNull();
    expect(await idempotencyKeyOf(json)).toBeNull();
    for (const clone of clones) expect(clone).not.toHaveBeenCalled();
    expect(await idempotencyKeyOf(posted(new URLSearchParams({ name: "Ada" })))).toBeNull();
    const upload = new FormData();
    upload.append(IDEMPOTENCY_KEY_FIELD, new Blob(["k"]), "key.txt");
    expect(await idempotencyKeyOf(posted(upload))).toBeNull();
  });

  it("never copies a form that declares a length over MAX_FORM_BYTES, which the header keys instead", async () => {
    const form = () => posted(new URLSearchParams({ [IDEMPOTENCY_KEY_FIELD]: "k" }));
    const large = form();
    large.headers.set("Content-Length", String(MAX_FORM_BYTES + 1));
    const clone = vi.spyOn(large, "clone");
    expect(await idempotencyKeyOf(large)).toBeNull();
    expect(clone).not.toHaveBeenCalled();
    const fitting = form();
    fitting.headers.set("Content-Length", String(MAX_FORM_BYTES));
    expect(await idempotencyKeyOf(fitting)).toBe("k");
    large.headers.set(IDEMPOTENCY_KEY_HEADER, "h");
    expect(await idempotencyKeyOf(large)).toBe("h");
  });

  it("finds no key in a body already read, or one that does not parse, and does not throw", async () => {
    const read = posted(new URLSearchParams({ [IDEMPOTENCY_KEY_FIELD]: "k" }));
    await read.text();
    expect(await idempotencyKeyOf(read)).toBeNull();

    const broken = posted("not multipart", {
      "Content-Type": "multipart/form-data; boundary=missing",
    });
    expect(await idempotencyKeyOf(broken)).toBeNull();
    await expect(broken.formData()).rejects.toThrow();
  });
});

describe("withIdempotencyKey", () => {
  it("hands every command a key of its own from the header, unless the caller passes one", async () => {
    const { client, calls } = recording();
    const served = await withIdempotencyKey(client, request("req-1"));
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
      const commands = (await withIdempotencyKey(client, request("req-3")))
        .commands as unknown as Record<string, (payload: unknown) => Promise<unknown>>;
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
    expect(await withIdempotencyKey(client, request())).toBe(client);
    const served = await withIdempotencyKey(client, request(""));
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
    const served = await withIdempotencyKey(client, request("req-2"));
    await (
      served.commands as unknown as Record<string, (payload: unknown) => Promise<unknown>>
    ).anything?.({ id: "1" });
    expect(calls).toEqual([
      ["anything", { id: "1" }, { idempotencyKey: idempotencyKeyFor("req-2", "anything") }],
    ]);
    expect((served.commands as unknown as { then?: unknown }).then).toBeUndefined();
  });
});
