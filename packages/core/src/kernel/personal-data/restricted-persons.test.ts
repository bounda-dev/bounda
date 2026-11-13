import { describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { memory } from "../../memory/index.ts";
import { restrictedPersonsHosts, restrictedPersonsSubscriberName } from "./restricted-persons.ts";

describe("restrictedPersonsSubscriberName", () => {
  it("is named after the read model it writes through", () => {
    expect(restrictedPersonsSubscriberName("orders")).toBe("restrictions:orders");
  });
});

describe("restrictedPersonsHosts", () => {
  it("picks per database the first read model by name that holds a field marked .person()", () => {
    const first: Adapter = memory();
    const second: Adapter = memory();
    const readModel = (name: string, person: boolean) => ({
      name,
      storage: {} as never,
      personalData: person ? ({} as never) : null,
    });
    const on: Record<string, Adapter> = { c: first, b: first, a: first, d: second, e: second };
    expect(
      restrictedPersonsHosts({
        readModels: [
          readModel("c", true),
          readModel("b", true),
          readModel("a", false),
          readModel("e", true),
          readModel("d", true),
        ],
        adapterOf: (name) => on[name] as Adapter,
      }).map(({ name }) => name),
    ).toEqual(["b", "d"]);
  });
});
