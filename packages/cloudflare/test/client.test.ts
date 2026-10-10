import { ConfigurationError, type Consistency } from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { connect } from "../src/client.ts";
import type { registry } from "./app.ts";
import { recordingStub } from "./recording-stub.ts";

describe("connect", () => {
  it("sends every command with its consistency, read-your-writes unless told otherwise", async () => {
    const eventual = recordingStub();
    await connect<typeof registry>(eventual.stub, { consistency: "eventual" }).commands.payOrder(
      { orderId: "o-1" },
      { correlationId: "c-1" },
    );
    expect(eventual.commands).toEqual([
      ["payOrder", { orderId: "o-1" }, { correlationId: "c-1" }, "eventual"],
    ]);

    const byDefault = recordingStub();
    await connect<typeof registry>(byDefault.stub).commands.payOrder({ orderId: "o-1" });
    expect(byDefault.commands).toEqual([
      ["payOrder", { orderId: "o-1" }, undefined, "read-your-writes"],
    ]);
  });

  it("is not taken for a promise, and has no members but named calls", async () => {
    const store = connect<typeof registry>(recordingStub().stub);
    expect(Reflect.get(store.commands, "then")).toBeUndefined();
    expect(Reflect.get(store.queries, Symbol.iterator)).toBeUndefined();
    expect(await Promise.resolve(store.queries)).toBe(store.queries);
  });

  it("refuses a consistency it does not know", () => {
    const { stub } = recordingStub();
    expect(() => connect(stub, { consistency: "eventually" as Consistency })).toThrow(
      new ConfigurationError(
        'consistency must be "read-your-writes" or "eventual", got "eventually"',
      ),
    );
  });
});
