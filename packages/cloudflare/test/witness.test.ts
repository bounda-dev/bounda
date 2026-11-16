import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  expectForgotten,
  expectRedacted,
  expectTenantForgotten,
  type NotForgottenError,
  type NotRedactedError,
} from "@bounda-dev/core/testing";
import { describe, expect, it } from "vitest";
import { connect } from "../src/client.ts";
import { cloudflare } from "../src/definition.ts";
import { witnessObjects } from "../src/testing.ts";
import { witnessOf } from "../src/witnesses.ts";
import { createWorker } from "../src/worker.ts";
import type { quietRegistry } from "./app.ts";
import { WitnessedStore } from "./test-worker.ts";

witnessObjects(WitnessedStore);

const fresh = () => env.WITNESSED_STORE.get(env.WITNESSED_STORE.newUniqueId());

// The orders read model keeps the note in the clear until it is rebuilt from after the forgetting.
const rebuilt = (stub: ReturnType<typeof fresh>) =>
  runInDurableObject(stub, async (object) => {
    for (;;) {
      const slice = await object.rebuildReadModel("orders");
      if (!slice.ok || slice.value.done) return;
    }
  });

const rejection = (pending: Promise<unknown>): Promise<unknown> =>
  pending.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );

describe("a Durable Object of a class witnessObjects watches", () => {
  it("passes once a person is forgotten, with nothing passed by hand", async () => {
    const stub = fresh();
    const store = connect<typeof quietRegistry>(stub);
    await store.commands.placeOrder({ orderId: "o-1", total: 7, customer: "ada", note: "no bell" });
    await store.forget("ada");
    await rebuilt(stub);
    await runInDurableObject(stub, (object) => expectForgotten(object, "ada"));
  });

  it("finds what its app sealed, wherever it was left in the clear", async () => {
    const stub = fresh();
    const store = connect<typeof quietRegistry>(stub);
    const note = "ring twice at seven";
    await store.commands.placeOrder({ orderId: "o-1", total: 7, customer: "ada", note });
    await store.commands.remarkOrder({ orderId: "o-1", remark: note });
    await store.forget("ada");
    const error = (await runInDurableObject(stub, (object) =>
      rejection(expectForgotten(object, "ada")),
    )) as NotForgottenError;
    expect(error.found).toContainEqual({
      value: note,
      store: "bounda_events",
      row: "position=2",
      field: "payload.remark",
    });
  });

  it("searches the forget ledger its app keeps in KV", async () => {
    const stub = fresh();
    const store = connect<typeof quietRegistry>(stub);
    await store.commands.placeOrder({ orderId: "o-1", total: 7, customer: "ada", note: "no bell" });
    await store.forget("ada");
    const forgetting = (await store.exportPersonalData("ada")).events.find(
      ({ type }) => type === "PersonalDataForgotten",
    );
    if (forgetting === undefined) throw new Error("no forgetting exported");
    const error = (await runInDurableObject(stub, (object) =>
      rejection(expectForgotten(object, "ada", { values: [forgetting.id] })),
    )) as NotForgottenError;
    expect(error.found).toContainEqual({
      value: forgetting.id,
      store: "forget ledger",
      row: `eventId=${forgetting.id}`,
      field: "eventId",
    });
  });

  it("searches its app's spans and logs, and what the object logs itself", async () => {
    const stub = fresh();
    const error = (await runInDurableObject(stub, async (object) => {
      for (const orderId of ["o-1", "o-2"]) {
        await object.command(
          "placeOrder",
          { orderId, total: 5, customer: "ada" },
          undefined,
          undefined,
          "ada@example.com",
        );
      }
      await object.rebuildReadModel("orders");
      await object.alarm();
      return rejection(
        expectForgotten(object, "ada", { values: ["ada@example.com", "bounda rebuild finished"] }),
      );
    })) as NotForgottenError;
    expect(error.found.map(({ store, field }) => `${store} ${field}`)).toEqual(
      expect.arrayContaining([
        "bounda_events metadata.actor",
        "spans attributes.bounda.actor",
        "logs message",
      ]),
    );
    // Another object sees none of what this one logged.
    const other = fresh();
    await connect<typeof quietRegistry>(other).commands.placeOrder({
      orderId: "o-1",
      total: 5,
      customer: "ada",
    });
    await runInDurableObject(other, (object) =>
      expectForgotten(object, "ada", { values: ["bounda rebuild finished"] }),
    );
  });

  it("checks a redaction and a tenant's forgetting given the object", async () => {
    const stub = env.WITNESSED_STORE.get(env.WITNESSED_STORE.idFromName("witnessed-tenant"));
    const store = connect<typeof quietRegistry>(stub);
    await store.commands.placeOrder({ orderId: "o-1", total: 7, customer: "ada", note: "no bell" });
    const [placed] = (await store.exportPersonalData("ada")).events;
    if (placed === undefined) throw new Error("no event exported");
    await store.redact("ada", { events: [{ ...placed, fields: ["note"] }] } as never);
    await store.commands.remarkOrder({ orderId: "o-1", remark: "no bell" });
    const redacted = (await runInDurableObject(stub, async (object) => {
      await object.alarm();
      return rejection(expectRedacted(object, "ada"));
    })) as NotRedactedError;
    expect(redacted.found).toContainEqual({
      value: "no bell",
      store: "bounda_events",
      row: "position=3",
      field: "payload.remark",
    });
    await store.forgetTenant("witnessed-tenant", { despiteLegalObligations: true });
    // Once its recipients are told, the object empties its storage and opens anew over it.
    await runInDurableObject(stub, (object) => object.alarm());
    await runInDurableObject(stub, (object) => expectTenantForgotten(object));
  });

  it("is one witness for the class, however often watched, and another for a subclass watched itself", () => {
    const witness = witnessObjects(WitnessedStore);
    expect(witnessObjects(WitnessedStore)).toBe(witness);
    expect(witnessOf(WitnessedStore)).toBe(witness);
    const inherited = class extends WitnessedStore {};
    const apart = class extends WitnessedStore {};
    const own = witnessObjects(apart);
    expect(witnessOf(inherited)).toBe(witness);
    expect(witnessOf(apart)).toBe(own);
    expect(own).not.toBe(witness);
  });

  it("searches what the Worker in front logs, with every object's persons", async () => {
    const worker = createWorker({
      config: {
        storage: cloudflare({ binding: "WITNESSED_STORE" }),
        runtime: { telemetry: { errorText: "include" } },
      },
      tenantOf: () => {
        throw new Error("no store for ada@example.com");
      },
    });
    const witness = witnessObjects(WitnessedStore, { hosts: [worker] });
    expect(witnessOf(worker)).toBe(witness);
    const request = new Request("http://example.com/commands/placeOrder", {
      method: "POST",
      body: JSON.stringify({ orderId: "o-1", total: 1, customer: "ada" }),
    });
    const response = await worker.fetch?.(
      request as Request<unknown, IncomingRequestCfProperties>,
      env,
      {} as ExecutionContext,
    );
    expect(response?.status).toBe(500);
    const stub = fresh();
    await connect<typeof quietRegistry>(stub).commands.placeOrder({
      orderId: "o-1",
      total: 7,
      customer: "ada",
    });
    const error = (await runInDurableObject(stub, (object) =>
      rejection(expectForgotten(object, "ada", { values: ["ada@example.com"] })),
    )) as NotForgottenError;
    expect(error.found).toContainEqual(
      expect.objectContaining({
        store: "logs",
        row: expect.stringContaining('"bounda worker request failed"'),
        field: "fields.errorMessage",
      }),
    );
  });

  it("leaves an object of a class it does not watch to be refused", async () => {
    const stub = env.QUIET_STORE.get(env.QUIET_STORE.newUniqueId());
    const error = await runInDurableObject(stub, (object) =>
      rejection(expectForgotten(object, "ada")),
    );
    expect(error).toBeInstanceOf(TypeError);
  });
});
