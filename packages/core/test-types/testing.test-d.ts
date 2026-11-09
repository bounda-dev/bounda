import type { BoundaClient, CreateAppArgs, PersonalDataExport } from "@bounda-dev/core";
import type { Adapter } from "@bounda-dev/core/adapter";
import type { AppTestPorts } from "@bounda-dev/core/register";
import {
  type CreateTestAppArgs,
  type createTestApp,
  type ExpectForgottenOptions,
  type ExpectForgottenTarget,
  expectForgotten,
  type ForgottenValueFound,
  type NotForgottenError,
  recordTelemetry,
  type TelemetryRecording,
} from "@bounda-dev/core/testing";
import { describe, expectTypeOf, it } from "vitest";
import type { registry } from "./fixtures/order-app/.bounda/registry.ts";
import type { TestPorts } from "./fixtures/order-app/.bounda/types.ts";

type Args = CreateTestAppArgs<typeof registry>;
type Ports = NonNullable<Args["ports"]>;

const inventory = { reserve: async () => {} };

describe("createTestApp ports", () => {
  it("are the TestPorts the project registers", () => {
    expectTypeOf<AppTestPorts>().toEqualTypeOf<TestPorts>();
    expectTypeOf<Ports>().toEqualTypeOf<TestPorts>();
  });

  it("take an implementation name or a double of the port, and require none", () => {
    const none: Ports = {};
    const some: Ports = { order: {} };
    const named: Ports = { order: { inventory: "memory", reminders: "fake" } };
    const double: Ports = { order: { inventory } };
    const readModel: Ports = { orderSummary: { rates: async () => 1 } };
    void [none, some, named, double, readModel];
  });

  it("reject a misspelt name, a value of another type, or an unknown port", () => {
    const misspelt: Ports = {
      // @ts-expect-error "memroy" is not an implementation of inventory
      order: { inventory: "memroy" },
    };
    const wrong: Ports = {
      // @ts-expect-error a number is not an Inventory
      order: { inventory: 1 },
    };
    const unknown: Ports = {
      // @ts-expect-error order has no sms port
      order: { sms: "fake" },
    };
    void [misspelt, wrong, unknown];
  });

  it("are no longer accepted under config", () => {
    const config: NonNullable<Args["config"]> = {
      // @ts-expect-error createTestApp takes ports as its own option
      ports: { order: { inventory: "fake" } },
    };
    void config;
  });
});

describe("the tenant of an app", () => {
  it("is an optional name for createTestApp, and for createApp one a host may not have", () => {
    expectTypeOf<Pick<Args, "tenant">>().toEqualTypeOf<{ readonly tenant?: string }>();
    expectTypeOf<Pick<CreateAppArgs<typeof registry>, "tenant">>().toEqualTypeOf<{
      readonly tenant?: string | undefined;
    }>();
  });
});

describe("createTestApp's app", () => {
  it("binds to who acts with as, typed from the registry", () => {
    type App = Awaited<ReturnType<typeof createTestApp<typeof registry>>>["app"];
    expectTypeOf<ReturnType<App["as"]>>().toEqualTypeOf<BoundaClient<typeof registry>>();
    expectTypeOf<ReturnType<App["as"]>["commands"]>().toEqualTypeOf<App["commands"]>();
  });
});

describe("expectForgotten", () => {
  it("takes the app createTestApp returns, or an adapter, and a person's id", () => {
    type Created = Awaited<ReturnType<typeof createTestApp<typeof registry>>>;
    expectTypeOf<Created["app"]>().toExtend<ExpectForgottenTarget>();
    expectTypeOf<Adapter>().toExtend<ExpectForgottenTarget>();
    expectTypeOf(expectForgotten).parameter(1).toEqualTypeOf<string>();
    expectTypeOf(expectForgotten).returns.toEqualTypeOf<Promise<void>>();
  });

  it("refuses what is neither", () => {
    // @ts-expect-error a string is no app
    void expectForgotten("app", "c-1");
    // @ts-expect-error an object without forget is no app
    void expectForgotten({ commands: {} }, "c-1");
  });

  it("looks for more values, an export taken before, the telemetry and more places", () => {
    expectTypeOf<ExpectForgottenOptions>().toEqualTypeOf<{
      readonly values?: readonly unknown[];
      readonly before?: PersonalDataExport;
      readonly telemetry?: TelemetryRecording;
      readonly places?: Readonly<Record<string, unknown>>;
    }>();
    // @ts-expect-error before is an export, not a list of values
    const wrong: ExpectForgottenOptions = { before: ["ana@example.com"] };
    void wrong;
  });

  it("rejects with what it found, place by place", () => {
    expectTypeOf<NotForgottenError["found"]>().toEqualTypeOf<readonly ForgottenValueFound[]>();
    expectTypeOf<ForgottenValueFound>().toEqualTypeOf<{
      readonly value: string;
      readonly store: string;
      readonly row: string;
      readonly field: string;
    }>();
    expectTypeOf<NotForgottenError>().toExtend<Error>();
  });

  it("records the telemetry until stopped", () => {
    expectTypeOf(recordTelemetry).returns.toEqualTypeOf<TelemetryRecording>();
    expectTypeOf<TelemetryRecording["stop"]>().toEqualTypeOf<() => void>();
  });
});
