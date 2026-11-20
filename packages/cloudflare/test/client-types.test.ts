import { env } from "cloudflare:workers";
import type {
  BoundaClient,
  CreateAppArgs,
  DeadLetter,
  DispatchResult,
  Registry,
  ScheduledDispatch,
  StoredDispatch,
  StoredEvent,
} from "@bounda-dev/core";
import type { VersionedTenantKeyRecord } from "@bounda-dev/core/adapter";
import type { ForgetLedgerDefinition, TenantKeyStoreDefinition } from "@bounda-dev/core/config";
import type { CreateTestAppArgs } from "@bounda-dev/core/testing";
import { describe, expectTypeOf, it } from "vitest";
import { type BoundaStub, connect } from "../src/client.ts";
import { type CloudflareDefinition, cloudflare } from "../src/definition.ts";
import {
  type BoundaKeeperClass,
  type BoundaKeeperMethods,
  createBoundaKeeper,
  type DEFAULT_KEEPER_BINDING,
  type DurableObjectKeeperOptions,
  durableObjectForgetLedger,
  durableObjectTenantKeys,
  type RpcOutcome,
} from "../src/index.ts";
import { tenantStub } from "../src/tenant-stub.ts";
import type { regionRegistry, registry } from "./app.ts";
import type { Store } from "./test-worker.ts";

describe("connect", () => {
  it("types commands and queries from the registry, as app.commands and app.queries are", () => {
    const store = connect<typeof registry>(env.STORE.get(env.STORE.newUniqueId()));
    expectTypeOf(store).toEqualTypeOf<BoundaClient<typeof registry>>();
    expectTypeOf(store.commands.placeOrder).parameter(0).toEqualTypeOf<{
      orderId: string;
      total: number;
      customer: string;
      note?: string | undefined;
    }>();
    expectTypeOf<ReturnType<typeof store.commands.payOrder>>().toEqualTypeOf<
      Promise<DispatchResult>
    >();
    expectTypeOf(store.queries.getOrder).parameter(0).toEqualTypeOf<{ orderId: string }>();
    expectTypeOf(store.deadLetters.list).returns.resolves.toEqualTypeOf<readonly DeadLetter[]>();
    expectTypeOf(store.events.read).returns.resolves.toEqualTypeOf<readonly StoredEvent[]>();
    // @ts-expect-error there is no such command
    void store.commands.shipOrder;
    // Never called: each call is an RPC to the object, and one still in flight when the file ends
    // fails the run once workerd is torn down.
    const calls = () => {
      expectTypeOf(
        store.commands.payOrder({ orderId: "o-1" }),
      ).resolves.toEqualTypeOf<StoredDispatch>();
      expectTypeOf(
        store.commands.payOrder({ orderId: "o-1" }, { delay: "1h" }),
      ).resolves.toEqualTypeOf<ScheduledDispatch>();
      // @ts-expect-error total must be a number
      void store.commands.placeOrder({ orderId: "o-1", total: "42", customer: "ada" });
      // @ts-expect-error not a consistency
      void connect(env.STORE.get(env.STORE.newUniqueId()), { consistency: "eventually" });
    };
    void calls;
  });
});

describe("tenantStub", () => {
  it("types the stub as the object's class when given one, and as what connect takes otherwise", () => {
    const config = { storage: cloudflare() };
    const typed = () => tenantStub<InstanceType<typeof Store>>({ config, env, tenant: "a" });
    expectTypeOf<ReturnType<typeof typed>>().toEqualTypeOf<
      DurableObjectStub<InstanceType<typeof Store>>
    >();
    expectTypeOf<ReturnType<typeof typed>>().toExtend<BoundaStub>();
    const untyped = () => tenantStub({ config, env, tenant: "a" });
    expectTypeOf<ReturnType<typeof untyped>>().toEqualTypeOf<DurableObjectStub & BoundaStub>();
  });
});

/**
 * A registry whose only implementation that exports `create` is a read model's.
 */
const readModelRegistry = {
  aggregates: {},
  readModels: {
    summary: {
      view: { fields: () => ({}) },
      projections: {},
      queries: {},
      ports: { rates: { live: { create: () => async () => 1 } } },
    },
  },
} satisfies Registry;

describe("the env implementations receive on Cloudflare", () => {
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

  it("is required too when only a read model's implementation exports create", () => {
    // @ts-expect-error rates is built by create, which needs the bindings Cloudflare.Env promises
    const withoutEnv: CreateTestAppArgs<typeof readModelRegistry> = { registry: readModelRegistry };
    const withEnv: CreateTestAppArgs<typeof readModelRegistry> = {
      registry: readModelRegistry,
      env,
    };
    void [withoutEnv, withEnv];
  });

  it("stays optional for a registry whose implementations need none", () => {
    const withoutEnv: CreateTestAppArgs<typeof registry> = { registry: {} as typeof registry };
    void withoutEnv;
  });
});

describe("the keeper", () => {
  it("gives tenant key stores and forget ledgers of the app's storage, and a class to bind", () => {
    const storage = cloudflare({ jurisdiction: "eu" });
    expectTypeOf(durableObjectTenantKeys({ storage })).toEqualTypeOf<TenantKeyStoreDefinition>();
    expectTypeOf(
      durableObjectForgetLedger({ storage, binding: "KEEPER" }),
    ).toEqualTypeOf<ForgetLedgerDefinition>();
    expectTypeOf<DurableObjectKeeperOptions>().toEqualTypeOf<{
      readonly storage: CloudflareDefinition;
      readonly binding?: string;
    }>();
    const elsewhere = () =>
      // @ts-expect-error the keeper shares the jurisdiction of the app's cloudflare(), not another adapter's
      durableObjectTenantKeys({ storage: { kind: "bounda-adapter", name: "sqlite", options: {} } });
    void elsewhere;
    expectTypeOf(createBoundaKeeper({ config: { storage } })).toEqualTypeOf<BoundaKeeperClass>();
    expectTypeOf<ReturnType<BoundaKeeperMethods["getTenantKeys"]>>().toEqualTypeOf<
      Promise<RpcOutcome<VersionedTenantKeyRecord | null>>
    >();
    expectTypeOf<typeof DEFAULT_KEEPER_BINDING>().toEqualTypeOf<"KEEPER">();
  });
});
