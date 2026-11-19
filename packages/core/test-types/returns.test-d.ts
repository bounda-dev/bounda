import type {
  ClassifiesReturns,
  InventoryCategory,
  PersonalCategoryName,
  PersonalDataReturned,
  PortCall,
  ReturnedPersons,
  ReturnsPersonalData,
} from "@bounda-dev/core";
import { describe, expectTypeOf, it } from "vitest";
import type {
  OrderPortReturns,
  OrderSummaryPortReturns,
} from "./fixtures/order-app/.bounda/types.ts";
import type { Port } from "./fixtures/order-app/app/domain/order/+types/contacts.ts";
import type * as contacts from "./fixtures/order-app/app/domain/order/contacts.ts";
import type { Contact, Contacts } from "./fixtures/order-app/app/domain/order/contacts.ts";
import type { Projection } from "./fixtures/order-app/app/read/order-summary/projections/order/+types/order-placed.ts";

interface Directory {
  lookup(id: string): Promise<{ readonly name: string } | null>;
  count(): Promise<number>;
  label(id: string): string;
  close(): Promise<void>;
}

type Lookup = (id: string) => Promise<{ readonly email: string }>;

describe("returnsPersonalData", () => {
  it("types each method's call with its arguments and what its promise resolves to", () => {
    expectTypeOf<Port.ReturnsPersonalData>().toEqualTypeOf<ReturnsPersonalData<Contacts>>();
    type Find = Exclude<Exclude<Port.ReturnsPersonalData, false>["find"], false>;
    expectTypeOf<Parameters<Find["persons"]>[0]>().toEqualTypeOf<
      PortCall<[customerId: string], Contact | null>
    >();
    expectTypeOf<ReturnType<Find["persons"]>>().toEqualTypeOf<ReturnedPersons>();
    expectTypeOf<NonNullable<Find["categories"]>[number]>().toEqualTypeOf<PersonalCategoryName>();
    type Household = Exclude<Exclude<Port.ReturnsPersonalData, false>["household"], false>;
    expectTypeOf<Parameters<NonNullable<Household["personsOnError"]>>[0]["args"]>().toEqualTypeOf<
      [customerId: string]
    >();
    expectTypeOf<typeof contacts.returnsPersonalData>().toExtend<Port.ReturnsPersonalData>();
  });

  it("checks every port of the fixture in .bounda/types.ts", () => {
    expectTypeOf<OrderPortReturns>().toEqualTypeOf<[true, true, true, true, true]>();
    expectTypeOf<OrderSummaryPortReturns>().toEqualTypeOf<[true]>();
  });

  it("asks for each method that answers what can hold text, and takes `false` for any", () => {
    const declared = {
      lookup: { persons: ({ args: [id] }) => id, categories: ["delivery"] },
      label: false,
      close: false,
    } satisfies ReturnsPersonalData<Directory>;
    expectTypeOf(declared).toExtend<ReturnsPersonalData<Directory>>();
    // @ts-expect-error lookup answers what can hold text, so it is declared
    void ({ label: false } satisfies ReturnsPersonalData<Directory>);
    void ({
      lookup: false,
      // @ts-expect-error a method answered synchronously can only return nobody's data
      label: { persons: () => null },
    } satisfies ReturnsPersonalData<Directory>);
    void ({
      lookup: {
        persons: () => null,
        // @ts-expect-error a category the app does not declare
        categories: ["marketing"],
      },
      label: false,
    } satisfies ReturnsPersonalData<Directory>);
    // @ts-expect-error a method the port does not have
    void ({ lookup: false, label: false, find: false } satisfies ReturnsPersonalData<Directory>);
    void ({
      // @ts-expect-error persons names ids
      lookup: { persons: () => 42 },
      label: false,
    } satisfies ReturnsPersonalData<Directory>);
    expectTypeOf(false as const).toExtend<ReturnsPersonalData<Directory>>();
  });

  it("types a port that is a function by its call", () => {
    expectTypeOf<Exclude<ReturnsPersonalData<Lookup>, false>>().toEqualTypeOf<
      PersonalDataReturned<[id: string], { readonly email: string }>
    >();
    const declared = {
      persons: ({ args: [id], result }) => (result.email === "" ? null : id),
    } satisfies ReturnsPersonalData<Lookup>;
    expectTypeOf(declared).toExtend<ReturnsPersonalData<Lookup>>();
  });

  it("fails .bounda/types.ts with a message for what is left undeclared", () => {
    expectTypeOf<
      ClassifiesReturns<"order.directory", { readonly other: 1 }, Omit<Directory, "label">>
    >().toEqualTypeOf<"Port order.directory: method lookup answers what can hold text; export returnsPersonalData, saying whose personal data it returns, or false">();
    expectTypeOf<
      ClassifiesReturns<"order.lookup", object, Lookup>
    >().toEqualTypeOf<"Port order.lookup: it answers what can hold text; export returnsPersonalData, saying whose personal data it returns, or false">();
    expectTypeOf<
      ClassifiesReturns<
        "order.directory",
        { readonly returnsPersonalData: { lookup: 1 } },
        Directory
      >
    >().toEqualTypeOf<"Port order.directory: returnsPersonalData does not fit the port; type it with satisfies Port.ReturnsPersonalData">();
    expectTypeOf<
      ClassifiesReturns<"order.directory", { readonly returnsPersonalData: false }, Directory>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      ClassifiesReturns<"order.counter", object, { count(): Promise<number>; reset(): void }>
    >().toEqualTypeOf<true>();
    type Both = Lookup & { name(): Promise<string> };
    expectTypeOf<
      ClassifiesReturns<"order.both", object, Both>
    >().toEqualTypeOf<"Port order.both is a function whose method name answers what can hold text; split it into a function and a port of methods">();
  });
});

describe("rawReadOf", () => {
  it("takes person ids and the app's categories", () => {
    type RawReadOf = Projection.Args["client"]["rawReadOf"];
    expectTypeOf<Parameters<RawReadOf>[0]>().toEqualTypeOf<ReturnedPersons>();
    expectTypeOf<
      NonNullable<NonNullable<Parameters<RawReadOf>[1]>["categories"]>[number]
    >().toEqualTypeOf<PersonalCategoryName>();
    expectTypeOf<ReturnType<RawReadOf>>().toEqualTypeOf<Promise<void>>();
  });
});

describe("the record of processing", () => {
  it("lists, per category, the ports whose calls return its data", () => {
    expectTypeOf<InventoryCategory["ports"]>().toEqualTypeOf<readonly string[]>();
  });
});
