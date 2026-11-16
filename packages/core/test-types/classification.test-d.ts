import type {
  ClassifiesColumns,
  ClassifiesPayload,
  ClassifiesState,
  CommandPayloadArgs,
  EventPayloadArgs,
  FieldsArgs,
  HoldsText,
  ProcessStateArgs,
} from "@bounda-dev/core";
import { describe, expectTypeOf, it } from "vitest";

describe("HoldsText", () => {
  it("finds free text wherever it can be", () => {
    expectTypeOf<HoldsText<string>>().toEqualTypeOf<true>();
    expectTypeOf<HoldsText<`order-${string}`>>().toEqualTypeOf<true>();
    expectTypeOf<HoldsText<string & { readonly brand: "Sku" }>>().toEqualTypeOf<true>();
    expectTypeOf<HoldsText<unknown>>().toEqualTypeOf<true>();
    // biome-ignore lint/suspicious/noExplicitAny: placeholder
    expectTypeOf<HoldsText<any>>().toEqualTypeOf<true>();
    expectTypeOf<HoldsText<number | string>>().toEqualTypeOf<true>();
    expectTypeOf<HoldsText<readonly string[]>>().toEqualTypeOf<true>();
    expectTypeOf<HoldsText<[number, string]>>().toEqualTypeOf<true>();
    expectTypeOf<HoldsText<{ readonly a: { readonly b?: string } }>>().toEqualTypeOf<true>();
    expectTypeOf<HoldsText<Record<string, number>>>().toEqualTypeOf<true>();
    expectTypeOf<HoldsText<ReadonlyMap<number, string>>>().toEqualTypeOf<true>();
    expectTypeOf<HoldsText<ReadonlySet<string>>>().toEqualTypeOf<true>();
  });

  it("finds none in literals, numbers, booleans and dates", () => {
    expectTypeOf<HoldsText<"placed" | "paid">>().toEqualTypeOf<false>();
    expectTypeOf<HoldsText<number | boolean | null | undefined | Date>>().toEqualTypeOf<false>();
    expectTypeOf<HoldsText<readonly number[]>>().toEqualTypeOf<false>();
    expectTypeOf<HoldsText<Record<"a" | "b", number>>>().toEqualTypeOf<false>();
    expectTypeOf<HoldsText<{ readonly total: number; readonly at: Date }>>().toEqualTypeOf<false>();
    expectTypeOf<HoldsText<Record<number, boolean>>>().toEqualTypeOf<false>();
    expectTypeOf<HoldsText<() => string>>().toEqualTypeOf<false>();
    expectTypeOf<HoldsText<never>>().toEqualTypeOf<false>();
  });
});

describe("ClassifiesPayload", () => {
  it("passes a payload whose every field that can hold text is marked", () => {
    const module = {
      payload: ({ z, personal, person, notPersonal }: EventPayloadArgs) =>
        z.object({
          customerId: person(z.string()),
          email: personal(z.email()).optional(),
          sku: notPersonal(z.string()).default("x"),
          lines: notPersonal(z.array(z.object({ sku: z.string() }))),
          quantity: z.int(),
          status: z.enum(["placed", "paid"]),
          at: z.date(),
          paid: z.boolean(),
        }),
    };
    expectTypeOf<ClassifiesPayload<"order.OrderPlaced", typeof module>>().toEqualTypeOf<true>();
    expectTypeOf<
      ClassifiesPayload<"order.Ping", { readonly evolve: () => void }>
    >().toEqualTypeOf<true>();
  });

  it("names each field that can hold text and is not marked", () => {
    const module = {
      payload: ({ z }: CommandPayloadArgs) =>
        z.object({
          note: z.string(),
          tags: z.array(z.string()).optional(),
          meta: z.record(z.string(), z.number()),
          code: z.templateLiteral(["A-", z.number()]),
          total: z.number(),
          length: z.string().transform((value) => value.length),
          label: z.number().transform(String),
        }),
    };
    expectTypeOf<ClassifiesPayload<"order.placeOrder", typeof module>>().toEqualTypeOf<
      | "order.placeOrder: field note can hold text; mark it personal(), person() or notPersonal()"
      | "order.placeOrder: field tags can hold text; mark it personal(), person() or notPersonal()"
      | "order.placeOrder: field meta can hold text; mark it personal(), person() or notPersonal()"
      | "order.placeOrder: field code can hold text; mark it personal(), person() or notPersonal()"
      | "order.placeOrder: field length can hold text; mark it personal(), person() or notPersonal()"
      | "order.placeOrder: field label can hold text; mark it personal(), person() or notPersonal()"
    >();
  });

  it("refuses text no mark reaches", () => {
    const loose = { payload: ({ z }: EventPayloadArgs) => z.looseObject({ id: z.number() }) };
    const catchall = {
      payload: ({ z }: EventPayloadArgs) => z.object({ id: z.number() }).catchall(z.number()),
    };
    const flat = { payload: ({ z }: EventPayloadArgs) => z.string() };
    const numbers = { payload: ({ z }: EventPayloadArgs) => z.array(z.number()) };
    expectTypeOf<
      ClassifiesPayload<"a.Loose", typeof loose>
    >().toEqualTypeOf<"a.Loose keeps keys it does not declare, which no mark reaches; use z.object or z.strictObject">();
    expectTypeOf<
      ClassifiesPayload<"a.Catchall", typeof catchall>
    >().toEqualTypeOf<"a.Catchall keeps keys it does not declare, which no mark reaches; use z.object or z.strictObject">();
    expectTypeOf<
      ClassifiesPayload<"a.Flat", typeof flat>
    >().toEqualTypeOf<"a.Flat is not an object, so no mark reaches the text it holds; make it z.object({ ... })">();
    expectTypeOf<ClassifiesPayload<"a.Numbers", typeof numbers>>().toEqualTypeOf<true>();
  });
});

describe("ClassifiesState", () => {
  it("needs no mark on a moment, and one on any other field that can hold text", () => {
    const module = {
      state: ({ z, deadline, instant, notPersonal, personal }: ProcessStateArgs) =>
        z.object({
          reminder: deadline(),
          seenAt: instant().optional(),
          bornAt: personal(instant()),
          step: notPersonal(z.string()).nullable().default(null),
          note: z.string().nullable().default(null),
        }),
    };
    expectTypeOf<
      ClassifiesState<"order.lifecycle", typeof module>
    >().toEqualTypeOf<"order.lifecycle: field note can hold text; mark it personal(), person() or notPersonal()">();
  });
});

describe("ClassifiesColumns", () => {
  it("names each string column, and json column that can hold text, left unmarked", () => {
    const view = {
      fields: ({ f }: FieldsArgs) => ({
        id: f.string().primaryKey().notPersonal(),
        customerId: f.string().person(),
        email: f.string().personal().index(),
        status: f.string().optional(),
        tags: f.json<string[]>(),
        totals: f.json<number[]>(),
        checked: f.json<readonly string[]>().notPersonal(),
        total: f.number(),
        at: f.date(),
      }),
    };
    expectTypeOf<ClassifiesColumns<"orders", typeof view>>().toEqualTypeOf<
      | "Read model orders: column status can hold text; mark it .personal(), .person() or .notPersonal()"
      | "Read model orders: column tags can hold text; mark it .personal(), .person() or .notPersonal()"
    >();
    const classified = {
      fields: ({ f }: FieldsArgs) => ({ id: f.string().primaryKey().notPersonal() }),
    };
    expectTypeOf<ClassifiesColumns<"orders", typeof classified>>().toEqualTypeOf<true>();
  });
});
