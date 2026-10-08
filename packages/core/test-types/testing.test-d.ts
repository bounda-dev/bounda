import type { AppTestPorts } from "@bounda-dev/core/register";
import type { CreateTestAppArgs } from "@bounda-dev/core/testing";
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
    void [none, some, named, double];
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
