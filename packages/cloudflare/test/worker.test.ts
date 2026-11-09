import { createExecutionContext, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { ConfigurationError, type Consistency, type Logger } from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { connect } from "../src/client.ts";
import { cloudflare } from "../src/definition.ts";
import { type CreateWorkerArgs, createWorker } from "../src/worker.ts";
import { recordingStub } from "./recording-stub.ts";

const post = (path: string, body?: unknown, tenant?: string) =>
  exports.default.fetch(
    new Request(`https://bounda.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(tenant === undefined ? {} : { "x-bounda-tenant": tenant }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  );

// One request through a worker whose binding is a spy that hands out a recording stub.
const throughSpy = async (
  path: string,
  body: string,
  consistency?: Consistency,
  actorOf?: CreateWorkerArgs["actorOf"],
) => {
  const { stub, commands, queries, forgets } = recordingStub();
  const addressed: string[] = [];
  const spy = {
    idFromName: (name: string) => {
      addressed.push(name);
      return name;
    },
    get: () => stub,
  };
  const worker = createWorker({
    config: { storage: cloudflare({ binding: "SPY" }) },
    tenantOf: () => "acme",
    ...(consistency === undefined ? {} : { consistency }),
    ...(actorOf === undefined ? {} : { actorOf }),
  });
  const response = await worker.fetch?.(
    new Request(`https://bounda.test${path}`, { method: "POST", body }) as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    { SPY: spy } as unknown as Cloudflare.Env,
    createExecutionContext(),
  );
  return {
    status: response?.status,
    addressed,
    commands,
    forgets,
    ...(queries.length === 0 ? {} : { queries }),
  };
};

describe("createWorker", () => {
  it("dispatches a command and answers a query over JSON, for the tenant in the header", async () => {
    const placed = await post(
      "/commands/placeOrder",
      { orderId: "o-1", total: 42, customer: "ada" },
      "acme",
    );
    expect(placed.status).toBe(200);
    expect(placed.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await placed.json()).toMatchObject({ scheduled: false, aggregateId: "o-1", version: 1 });

    const found = await post("/queries/getOrder", { orderId: "o-1" }, "acme");
    expect(await found.json()).toEqual({ orderId: "o-1", status: "placed", total: 42 });
    const elsewhere = await post("/queries/getOrder", { orderId: "o-1" }, "globex");
    expect(await elsewhere.json()).toBeNull();
    const byDefault = await post("/queries/getOrder", { orderId: "o-1" });
    expect(await byDefault.json()).toBeNull();
  });

  it("sends commands through the binding the config names, with the worker's consistency, read-your-writes unless told otherwise", async () => {
    const payOrder = JSON.stringify({ orderId: "o-1" });
    expect(await throughSpy("/commands/payOrder", payOrder, "eventual")).toEqual({
      status: 200,
      addressed: ["acme"],
      commands: [["payOrder", { orderId: "o-1" }, {}, "eventual", undefined]],
      forgets: [],
    });
    expect(await throughSpy("/commands/payOrder", payOrder)).toEqual({
      status: 200,
      addressed: ["acme"],
      commands: [["payOrder", { orderId: "o-1" }, {}, "read-your-writes", undefined]],
      forgets: [],
    });
  });

  it("sends who makes the request, as actorOf names them, with its command or query", async () => {
    const actorOf = (request: Request) => request.headers.get("x-user") ?? undefined;
    const payOrder = JSON.stringify({ orderId: "o-1" });
    expect(await throughSpy("/commands/payOrder", payOrder, undefined, actorOf)).toMatchObject({
      commands: [["payOrder", { orderId: "o-1" }, {}, "read-your-writes", undefined]],
    });
    const actorOfUser = async () => "user-1";
    expect(await throughSpy("/commands/payOrder", payOrder, undefined, actorOfUser)).toMatchObject({
      commands: [["payOrder", { orderId: "o-1" }, {}, "read-your-writes", "user-1"]],
    });
    expect(await throughSpy("/queries/getOrder", payOrder, undefined, actorOfUser)).toMatchObject({
      queries: [["getOrder", { orderId: "o-1" }, "user-1"]],
    });
  });

  it("sends a blank body as no payload, and the delay and correlation id from the query string", async () => {
    expect((await throughSpy("/commands/payOrder", " \n")).commands).toEqual([
      ["payOrder", undefined, {}, "read-your-writes", undefined],
    ]);
    expect(
      (await throughSpy("/commands/payOrder/?delay=10m&correlationId=c-1", "{}")).commands,
    ).toEqual([
      ["payOrder", {}, { delay: "10m", correlationId: "c-1" }, "read-your-writes", undefined],
    ]);
  });

  it("answers a 500 and logs it when the binding the config names is missing", async () => {
    const errors: unknown[][] = [];
    const worker = createWorker({
      config: { storage: cloudflare({ binding: "MISSING" }) },
      tenantOf: () => "acme",
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (...entry) => void errors.push(entry),
      },
    });
    const response = await worker.fetch?.(
      new Request("https://bounda.test/queries/getOrder", {
        method: "POST",
        body: JSON.stringify({ orderId: "o-1" }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      {} as Cloudflare.Env,
      createExecutionContext(),
    );
    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual({
      error: { code: "INTERNAL", message: "Internal error" },
    });
    expect(errors).toEqual([["bounda worker has no such binding", { binding: "MISSING" }]]);
  });

  it.each([
    ["omits", undefined, { errorName: "Error" }],
    ["omits by default", "unset" as const, { errorName: "Error" }],
    [
      "includes",
      "include" as const,
      { errorName: "Error", errorMessage: "no session for ana@example.com" },
    ],
  ])(
    "answers a 500 when tenantOf throws, and %s the error's text in the log as the configuration says",
    async (_, errorText, logged) => {
      const errors: unknown[][] = [];
      const logger: Logger = {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (...entry) => void errors.push(entry),
      };
      const worker = createWorker({
        config: {
          storage: cloudflare({ binding: "SPY" }),
          ...(errorText === undefined
            ? {}
            : {
                runtime:
                  errorText === "unset" ? { role: "web" as const } : { telemetry: { errorText } },
              }),
        },
        tenantOf: () => {
          throw new Error("no session for ana@example.com");
        },
        logger,
      });
      const response = await worker.fetch?.(
        new Request("https://bounda.test/queries/getOrder", {
          method: "POST",
          body: JSON.stringify({ orderId: "o-1" }),
        }) as Request<unknown, IncomingRequestCfProperties>,
        {
          SPY: { idFromName: () => "id", get: () => recordingStub().stub },
        } as unknown as Cloudflare.Env,
        createExecutionContext(),
      );
      expect(response?.status).toBe(500);
      expect(await response?.json()).toEqual({
        error: { code: "INTERNAL", message: "Internal error" },
      });
      expect(errors).toEqual([
        [
          "bounda worker request failed",
          {
            path: "/queries/getOrder",
            ...logged,
            ...(errorText === "include" ? { errorStack: expect.any(String) } : {}),
          },
        ],
      ]);
    },
  );

  it.each([
    ["include", "omit", { errorMessage: "no session for ana@example.com" }],
    ["omit", "include", {}],
  ] as const)(
    "logs the error of a 500 as BOUNDA_ERROR_TEXT %s in the Worker's env says, over the configuration's %s",
    async (variable, configured, text) => {
      const errors: unknown[][] = [];
      const worker = createWorker({
        config: {
          storage: cloudflare({ binding: "SPY" }),
          runtime: { telemetry: { errorText: configured } },
        },
        tenantOf: () => {
          throw new Error("no session for ana@example.com");
        },
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: (...entry) => void errors.push(entry),
        },
      });
      const response = await worker.fetch?.(
        new Request("https://bounda.test/queries/getOrder", {
          method: "POST",
          body: JSON.stringify({ orderId: "o-1" }),
        }) as Request<unknown, IncomingRequestCfProperties>,
        {
          BOUNDA_ERROR_TEXT: variable,
          SPY: { idFromName: () => "id", get: () => recordingStub().stub },
        } as unknown as Cloudflare.Env,
        createExecutionContext(),
      );
      expect(response?.status).toBe(500);
      expect(errors).toEqual([
        [
          "bounda worker request failed",
          {
            path: "/queries/getOrder",
            errorName: "Error",
            ...text,
            ...("errorMessage" in text ? { errorStack: expect.any(String) } : {}),
          },
        ],
      ]);
    },
  );

  it("answers a 500 and logs it, without the value, when actorOf names no valid actor", async () => {
    const errors: unknown[][] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (...entry) => void errors.push(entry),
    };
    const { stub, queries } = recordingStub();
    const worker = createWorker({
      config: { storage: cloudflare({ binding: "SPY" }) },
      tenantOf: () => "acme",
      actorOf: () => "",
      logger,
    });
    const response = await worker.fetch?.(
      new Request("https://bounda.test/queries/getOrder", {
        method: "POST",
        body: JSON.stringify({ orderId: "o-1" }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      { SPY: { idFromName: () => "id", get: () => stub } } as unknown as Cloudflare.Env,
      createExecutionContext(),
    );
    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual({
      error: { code: "INTERNAL", message: "Internal error" },
    });
    expect(errors).toEqual([
      ["bounda worker actorOf named no valid actor", { path: "/queries/getOrder" }],
    ]);
    expect(queries).toEqual([]);
  });

  it("refuses a configuration without cloudflare() storage, or none at all", () => {
    expect(() => createWorker({ binding: "STORE" } as unknown as CreateWorkerArgs)).toThrow(
      new ConfigurationError(
        "A Bounda app on Cloudflare stores its events in its Durable Object's SQLite: set storage to cloudflare(), not undefined",
      ),
    );
  });

  it("refuses a storage that is not cloudflare()", () => {
    expect(() =>
      createWorker({
        config: { storage: { kind: "bounda-adapter", name: "sqlite", options: {} } },
        tenantOf: () => "acme",
      }),
    ).toThrow(
      new ConfigurationError(
        'A Bounda app on Cloudflare stores its events in its Durable Object\'s SQLite: set storage to cloudflare(), not "sqlite"',
      ),
    );
  });

  it("refuses a consistency it does not know", () => {
    expect(() =>
      createWorker({
        config: { storage: cloudflare() },
        tenantOf: () => "acme",
        consistency: "eventually" as Consistency,
      }),
    ).toThrow(
      new ConfigurationError(
        'consistency must be "read-your-writes" or "eventual", got "eventually"',
      ),
    );
  });

  it("schedules a command with ?delay", async () => {
    await post("/commands/placeOrder", { orderId: "o-2", total: 1, customer: "ada" }, "delays");
    const scheduled = await post("/commands/archiveOrder?delay=10m", { orderId: "o-2" }, "delays");
    expect(await scheduled.json()).toMatchObject({ scheduled: true, aggregateId: "o-2" });
    await runDurableObjectAlarm(env.STORE.get(env.STORE.idFromName("delays")));
  });

  it("answers refusals with their code and the status they mean", async () => {
    await post("/commands/placeOrder", { orderId: "o-3", total: 1, customer: "ada" }, "errors");
    const conflict = await post(
      "/commands/placeOrder",
      { orderId: "o-3", total: 1, customer: "ada" },
      "errors",
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: { code: "DOMAIN_ERROR", message: "Order already placed", rejected: "AlreadyPlaced" },
    });

    await connect(env.STORE.get(env.STORE.idFromName("errors"))).restrict("bo");
    const restricted = await post(
      "/commands/placeOrder",
      { orderId: "o-5", total: 1, customer: "bo" },
      "errors",
    );
    expect(restricted.status).toBe(409);
    expect(await restricted.json()).toEqual({
      error: {
        code: "PROCESSING_RESTRICTED",
        message: "The processing of this person's data is restricted",
      },
    });

    const invalid = await post("/commands/placeOrder", { orderId: "o-4", total: "lots" }, "errors");
    expect(invalid.status).toBe(400);
    const body = (await invalid.json()) as { error: { code: string; issues: unknown[] } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.issues.length).toBeGreaterThan(0);

    const unknown = await post("/commands/shipOrder", {}, "errors");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: { code: "NOT_FOUND", message: 'Unknown command "shipOrder"' },
    });

    const foreign = await post("/commands/noteOrder", { orderId: "o-3" }, "errors");
    expect(foreign.status).toBe(500);
    expect(await foreign.json()).toEqual({
      error: { code: "INTERNAL", message: "Internal error" },
    });

    const badJson = await post("/commands/placeOrder", "{not json", "errors");
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({
      error: { code: "INVALID_JSON", message: "The body is not JSON" },
    });
  });

  it("knows no command or query that is not the app's own, whatever the prototype offers", async () => {
    for (const path of [
      "/commands/constructor",
      "/commands/toString",
      "/commands/hasOwnProperty",
    ]) {
      const response = await post(path, { scheduled: true }, "prototype");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: {
          code: "NOT_FOUND",
          message: `Unknown command "${path.slice("/commands/".length)}"`,
        },
      });
    }
    for (const path of ["/queries/toString", "/queries/valueOf", "/queries/isPrototypeOf"]) {
      const response = await post(path, {}, "prototype");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "NOT_FOUND", message: `Unknown query "${path.slice("/queries/".length)}"` },
      });
    }
  });

  it("refuses a body over maxPayloadBytes with a 413, by its declared length or as it reads it", async () => {
    const { stub } = recordingStub();
    const worker = createWorker({
      config: { storage: cloudflare({ binding: "SPY" }) },
      tenantOf: () => "acme",
      maxPayloadBytes: 24,
    });
    const send = (body: BodyInit, headers: Record<string, string> = {}) =>
      worker.fetch?.(
        new Request("https://bounda.test/commands/placeOrder", {
          method: "POST",
          headers,
          body,
        }) as Request<unknown, IncomingRequestCfProperties>,
        {
          SPY: { idFromName: (name: string) => name, get: () => stub },
        } as unknown as Cloudflare.Env,
        createExecutionContext(),
      );
    const tooLarge = {
      error: { code: "PAYLOAD_TOO_LARGE", message: "The body is larger than 24 bytes" },
    };
    const declared = await send("{}", { "content-length": "25" });
    expect(declared?.status).toBe(413);
    expect(await declared?.json()).toEqual(tooLarge);
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"orderId":"o-1",'));
        controller.enqueue(new TextEncoder().encode('"total":1}'));
        controller.close();
      },
    });
    const streamed = await send(chunks);
    expect(streamed?.status).toBe(413);
    expect(await streamed?.json()).toEqual(tooLarge);
    const fitting = await send('{"orderId":"o-1"}');
    expect(fitting?.status).toBe(200);
  });

  it("only knows POST on its two routes", async () => {
    const root = await exports.default.fetch(new Request("https://bounda.test/"));
    expect(root.status).toBe(404);
    expect(await root.json()).toEqual({ error: { code: "NOT_FOUND", message: "No route for /" } });
    const get = await exports.default.fetch(new Request("https://bounda.test/queries/getOrder"));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    for (const path of [
      "/api/queries/getOrder",
      "/queries/getOrder/extra",
      "/queries/1st",
      "/forget",
      "/forget/",
      "/forget/a/b",
      "/forget/%E0%A4%A",
    ]) {
      const response = await post(path, { orderId: "o-1" });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "NOT_FOUND", message: `No route for ${path}` },
      });
    }
  });
});
