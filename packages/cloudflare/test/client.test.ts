import {
  ConfigurationError,
  type Consistency,
  MAX_ACTOR_LENGTH,
  ValidationError,
} from "@bounda-dev/core";
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
      ["payOrder", { orderId: "o-1" }, { correlationId: "c-1" }, "eventual", undefined],
    ]);

    const byDefault = recordingStub();
    await connect<typeof registry>(byDefault.stub).commands.payOrder({ orderId: "o-1" });
    expect(byDefault.commands).toEqual([
      ["payOrder", { orderId: "o-1" }, undefined, "read-your-writes", undefined],
    ]);
  });

  it("forgets a person, restricts their processing and lifts it with the same consistency as its commands", async () => {
    const eventual = recordingStub();
    const soon = connect<typeof registry>(eventual.stub, { consistency: "eventual" });
    await soon.forget("c-1");
    await soon.forget("c-1", { categories: ["default"] });
    await soon.restrict("c-1", { ground: "accuracy-contested" });
    await soon.unrestrict("c-1", { notice: "given" });
    const byDefault = recordingStub();
    const store = connect<typeof registry>(byDefault.stub);
    await store.forget("c-2");
    await store.restrict("c-2", { ground: "accuracy-contested" });
    await store.unrestrict("c-2", { notice: "given" });
    expect([eventual.forgets, byDefault.forgets]).toEqual([
      [
        ["c-1", "eventual", undefined, undefined],
        ["c-1", "eventual", undefined, { categories: ["default"] }],
        ["restrict", "c-1", "eventual", undefined, { ground: "accuracy-contested" }],
        ["unrestrict", "c-1", "eventual", undefined, { notice: "given" }],
      ],
      [
        ["c-2", "read-your-writes", undefined, undefined],
        ["restrict", "c-2", "read-your-writes", undefined, { ground: "accuracy-contested" }],
        ["unrestrict", "c-2", "read-your-writes", undefined, { notice: "given" }],
      ],
    ]);
  });

  it("exports a person's data through the stub", async () => {
    const { stub, exports } = recordingStub();
    await connect<typeof registry>(stub).exportPersonalData("c-1");
    expect(exports).toEqual([["c-1", undefined]]);
  });

  it("sends the actor of as with every call that acts, and none before it", async () => {
    const recorded = recordingStub();
    const store = connect<typeof registry>(recorded.stub, { consistency: "eventual" });
    const user = store.as("user-1");
    await user.commands.payOrder({ orderId: "o-1" });
    await user.queries.getOrder({ orderId: "o-1" });
    await user.forget("c-1");
    await user.restrict("c-1", { ground: "accuracy-contested" });
    await user.unrestrict("c-1", { notice: "given" });
    await user.exportPersonalData("c-1");
    await user.deadLetters.list({ status: "failed" });
    await user.deadLetters.retry("l-1");
    await user.as("operator-1").deadLetters.discard("l-1");
    await user.subscriberFailures.list();
    await store.subscriberFailures.get("projection:orders");
    await store.queries.getOrder({ orderId: "o-1" });
    expect(recorded).toMatchObject({
      commands: [["payOrder", { orderId: "o-1" }, undefined, "eventual", "user-1"]],
      queries: [
        ["getOrder", { orderId: "o-1" }, "user-1", undefined],
        ["getOrder", { orderId: "o-1" }, undefined, undefined],
      ],
      forgets: [
        ["c-1", "eventual", "user-1", undefined],
        ["restrict", "c-1", "eventual", "user-1", { ground: "accuracy-contested" }],
        ["unrestrict", "c-1", "eventual", "user-1", { notice: "given" }],
      ],
      exports: [["c-1", "user-1"]],
      deadLetters: [
        ["list", { status: "failed" }, "user-1", undefined],
        ["retry", "l-1", "user-1"],
        ["discard", "l-1", "operator-1"],
      ],
      failures: [
        ["list", "user-1", undefined],
        ["get", "projection:orders", undefined, undefined],
      ],
    });
  });

  it("refuses in as an actor that is not a string of 1 to MAX_ACTOR_LENGTH characters", () => {
    const store = connect(recordingStub().stub);
    expect(() => store.as("")).toThrow(ValidationError);
    expect(() => store.as("x".repeat(MAX_ACTOR_LENGTH + 1))).toThrow(ValidationError);
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
