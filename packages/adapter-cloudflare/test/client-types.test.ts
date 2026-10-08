import { env } from "cloudflare:workers";
import type {
  CreateAppArgs,
  DeadLetter,
  DispatchResult,
  ScheduledDispatch,
  StoredDispatch,
} from "@bounda-dev/core";
import type { CreateTestAppArgs } from "@bounda-dev/core/testing";
import { describe, expectTypeOf, it } from "vitest";
import { connect } from "../src/client.ts";
import type { regionRegistry, registry } from "./app.ts";

describe("connect", () => {
  it("types commands and queries from the registry, as app.commands and app.queries are", () => {
    const store = connect<typeof registry>(env.STORE.get(env.STORE.newUniqueId()));
    expectTypeOf(store.commands.placeOrder).parameter(0).toEqualTypeOf<{
      orderId: string;
      total: number;
      customer: string;
    }>();
    expectTypeOf<ReturnType<typeof store.commands.payOrder>>().toEqualTypeOf<
      Promise<DispatchResult>
    >();
    expectTypeOf(
      store.commands.payOrder({ orderId: "o-1" }),
    ).resolves.toEqualTypeOf<StoredDispatch>();
    expectTypeOf(
      store.commands.payOrder({ orderId: "o-1" }, { delay: "1h" }),
    ).resolves.toEqualTypeOf<ScheduledDispatch>();
    expectTypeOf(store.queries.getOrder).parameter(0).toEqualTypeOf<{ orderId: string }>();
    expectTypeOf(store.deadLetters.list).returns.resolves.toEqualTypeOf<readonly DeadLetter[]>();
    // @ts-expect-error total must be a number
    void store.commands.placeOrder({ orderId: "o-1", total: "42", customer: "ada" });
    // @ts-expect-error there is no such command
    void store.commands.shipOrder;
  });
});

describe("the env collaborators receive on Cloudflare", () => {
  it("is the Worker's Cloudflare.Env, required once an implementation exports create", () => {
    expectTypeOf<
      NonNullable<CreateAppArgs<typeof regionRegistry>["env"]>
    >().toEqualTypeOf<Cloudflare.Env>();
    const app = {} as typeof regionRegistry;
    // @ts-expect-error region is built by create, which needs the bindings Cloudflare.Env promises
    const withoutEnv: CreateTestAppArgs<typeof regionRegistry> = { registry: app };
    const withEnv: CreateTestAppArgs<typeof regionRegistry> = { registry: app, env };
    void [withoutEnv, withEnv];
  });

  it("stays optional for a registry whose implementations need none", () => {
    const withoutEnv: CreateTestAppArgs<typeof registry> = { registry: {} as typeof registry };
    void withoutEnv;
  });
});
