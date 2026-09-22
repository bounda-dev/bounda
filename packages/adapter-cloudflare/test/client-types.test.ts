import { env } from "cloudflare:workers";
import type { DeadLetter, DispatchResult } from "@bounda-dev/core";
import { describe, expectTypeOf, it } from "vitest";
import { connect } from "../src/client.ts";
import type { registry } from "./app.ts";

describe("connect", () => {
  it("types commands and queries from the registry, as app.commands and app.queries are", () => {
    const store = connect<typeof registry>(env.STORE.get(env.STORE.newUniqueId()));
    expectTypeOf(store.commands.placeOrder).parameter(0).toEqualTypeOf<{
      orderId: string;
      total: number;
      customer: string;
    }>();
    expectTypeOf(store.commands.payOrder).returns.resolves.toEqualTypeOf<DispatchResult>();
    expectTypeOf(store.queries.getOrder).parameter(0).toEqualTypeOf<{ orderId: string }>();
    expectTypeOf(store.deadLetters.list).returns.resolves.toEqualTypeOf<readonly DeadLetter[]>();
    // @ts-expect-error total must be a number
    void store.commands.placeOrder({ orderId: "o-1", total: "42", customer: "ada" });
    // @ts-expect-error there is no such command
    void store.commands.shipOrder;
  });
});
