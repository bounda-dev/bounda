import type { AppTestCollaborators } from "@bounda-dev/core/register";
import type { CreateTestAppArgs } from "@bounda-dev/core/testing";
import { describe, expectTypeOf, it } from "vitest";
import type { registry } from "./fixtures/order-app/.bounda/registry.ts";
import type { TestCollaborators } from "./fixtures/order-app/.bounda/types.ts";

type Args = CreateTestAppArgs<typeof registry>;
type Collaborators = NonNullable<Args["collaborators"]>;

const inventory = { reserve: async () => {} };

describe("createTestApp collaborators", () => {
  it("are the TestCollaborators the project registers", () => {
    expectTypeOf<AppTestCollaborators>().toEqualTypeOf<TestCollaborators>();
    expectTypeOf<Collaborators>().toEqualTypeOf<TestCollaborators>();
  });

  it("take an implementation name or a double of the port, and require none", () => {
    const none: Collaborators = {};
    const some: Collaborators = { order: {} };
    const named: Collaborators = { order: { inventory: "memory", reminders: "fake" } };
    const double: Collaborators = { order: { inventory } };
    void [none, some, named, double];
  });

  it("reject a misspelt name, a value of another type, or an unknown port", () => {
    const misspelt: Collaborators = {
      // @ts-expect-error "memroy" is not an implementation of inventory
      order: { inventory: "memroy" },
    };
    const wrong: Collaborators = {
      // @ts-expect-error a number is not an Inventory
      order: { inventory: 1 },
    };
    const unknown: Collaborators = {
      // @ts-expect-error order has no sms port
      order: { sms: "fake" },
    };
    void [misspelt, wrong, unknown];
  });

  it("are no longer accepted under config", () => {
    const config: NonNullable<Args["config"]> = {
      // @ts-expect-error createTestApp takes collaborators as its own option
      collaborators: { order: { inventory: "fake" } },
    };
    void config;
  });
});
