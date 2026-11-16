import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import { notPersonal, person, personal } from "../../modules/personal.ts";
import type { ProcessStateArgs } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import { type FieldsArgs, fieldBuilder as f } from "../../modules/view.ts";
import { createTestApp } from "../../testing/index.ts";
import { processStateArgs } from "../process/deadlines.ts";
import { checkClassification, classifySchema, classifyView, holdsText } from "./classification.ts";

describe("holdsText", () => {
  it.each([
    ["a string", z.string()],
    ["a string of a format", z.email()],
    ["a template literal", z.templateLiteral(["order-", z.string()])],
    ["unknown", z.unknown()],
    ["any", z.any()],
    ["JSON", z.json()],
    ["an optional string", z.string().optional()],
    ["a string with a default", z.string().default("x")],
    ["a string in an array", z.array(z.string())],
    ["a string in a nested object", z.object({ inner: z.object({ note: z.string() }) })],
    ["a string next to a number", z.object({ total: z.number(), note: z.string() })],
    ["a string in a tuple", z.tuple([z.number(), z.string()])],
    ["a string as the rest of a tuple", z.tuple([z.number()], z.string())],
    ["a string in a union", z.union([z.number(), z.string()])],
    ["the string keys of a record", z.record(z.string(), z.number())],
    ["the string values of a record", z.record(z.enum(["a"]), z.string())],
    ["a string in a map", z.map(z.number(), z.string())],
    ["a string in a set", z.set(z.string())],
    ["a string on one side of an intersection", z.intersection(z.object({}), z.string())],
    ["a string a transform reads", z.string().transform((value) => value.length)],
    ["a string piped into another", z.string().pipe(z.email())],
    ["an object that keeps keys it does not declare", z.looseObject({ id: z.number() })],
    ["a string through a lazy schema", z.lazy(() => z.string())],
  ])("finds text in %s", (_, schema) => {
    expect(holdsText(schema)).toBe(true);
  });

  it.each([
    ["a number", z.number()],
    ["a boolean", z.boolean()],
    ["a date", z.date()],
    ["a literal", z.literal("paid")],
    ["an enum", z.enum(["placed", "paid"])],
    ["a union of literals", z.union([z.literal("a"), z.literal("b")])],
    ["an array of numbers", z.array(z.int())],
    ["a tuple of numbers", z.tuple([z.number(), z.int()])],
    ["a tuple of numbers with a rest of booleans", z.tuple([z.number()], z.boolean())],
    ["a strict object of numbers", z.strictObject({ total: z.number() })],
    ["a record keyed by an enum", z.record(z.enum(["a", "b"]), z.number())],
    ["a moment of a process", processStateArgs.instant()],
    ["a deadline of a process", processStateArgs.deadline()],
    ["what a transform gives", z.number().transform(String)],
    ["a custom schema", z.custom<string>()],
  ])("finds none in %s", (_, schema) => {
    expect(holdsText(schema)).toBe(false);
  });

  it("ends on a schema that contains itself", () => {
    const node: z.ZodType = z.lazy(() => z.object({ children: z.array(node) }));
    expect(holdsText(node)).toBe(false);
  });
});

describe("classifySchema", () => {
  it("classifies each top-level field by its mark, a moment as one, and says which hold text", () => {
    const classified = classifySchema(
      z.object({
        customerId: person(z.string()),
        email: personal(z.email(), { category: "contact" }).optional(),
        sku: notPersonal(z.string()),
        note: z.string(),
        total: z.number(),
        at: processStateArgs.instant(),
        due: processStateArgs.deadline().optional(),
        lines: z.array(z.object({ sku: z.string() })),
      }),
    );
    expect(classified).toEqual({
      fields: [
        { name: "customerId", classification: { mark: "person" }, holdsText: true },
        {
          name: "email",
          classification: { mark: "personal", category: "contact" },
          holdsText: true,
        },
        { name: "sku", classification: { mark: "not-personal" }, holdsText: true },
        { name: "note", classification: null, holdsText: true },
        { name: "total", classification: null, holdsText: false },
        { name: "at", classification: { mark: "instant" }, holdsText: false },
        { name: "due", classification: { mark: "instant" }, holdsText: false },
        { name: "lines", classification: null, holdsText: true },
      ],
      unmarkableText: false,
    });
  });

  it("reads a moment marked personal as personal", () => {
    const [field] = classifySchema(z.object({ born: personal(processStateArgs.instant()) })).fields;
    expect(field?.classification).toEqual({ mark: "personal", category: "default" });
  });

  it("tells text no mark reaches: a payload that is not an object, or keys it does not declare", () => {
    expect(classifySchema(z.string())).toEqual({ fields: [], unmarkableText: true });
    expect(classifySchema(z.array(z.number()))).toEqual({ fields: [], unmarkableText: false });
    expect(classifySchema(z.looseObject({})).unmarkableText).toBe(true);
    expect(classifySchema(z.object({}).catchall(z.number())).unmarkableText).toBe(true);
    expect(classifySchema(z.object({ id: z.number() })).unmarkableText).toBe(false);
    expect(classifySchema(z.strictObject({})).unmarkableText).toBe(false);
  });
});

describe("classifyView", () => {
  it("counts every string column as text, whatever its projections write", () => {
    expect(
      classifyView({
        id: f.string().primaryKey().notPersonal(),
        customerId: f.string().person(),
        email: f.string().personal(),
        status: f.string(),
        total: f.number(),
        lines: f.json<string[]>(),
      }),
    ).toEqual([
      { name: "id", mark: "not-personal", holdsText: true },
      { name: "customerId", mark: "person", holdsText: true },
      { name: "email", mark: "personal", holdsText: true },
      { name: "status", mark: null, holdsText: true },
      { name: "total", mark: null, holdsText: false },
      { name: "lines", mark: null, holdsText: false },
    ]);
  });
});

describe("checkClassification", () => {
  const registry = (aggregates: object, readModels: object = {}): Registry =>
    ({ aggregates, readModels }) as unknown as Registry;
  const aggregate = (parts: object) => ({
    events: {},
    commands: {},
    policies: {},
    processes: {},
    ...parts,
  });

  it("lets an app whose every field that can hold text is marked start", () => {
    expect(() =>
      checkClassification(
        registry(
          {
            order: aggregate({
              events: {
                orderPlaced: {
                  payload: ({ z, notPersonal, person }: EventPayloadArgs) =>
                    z.object({ sku: notPersonal(z.string()), customerId: person(z.string()) }),
                },
                orderPaid: {},
              },
              commands: { cancelOrder: { module: {} } },
              processes: {
                lifecycle: {
                  module: {
                    state: ({ z, deadline }: ProcessStateArgs) =>
                      z.object({ due: deadline(), total: z.number() }),
                  },
                },
                quiet: { module: {} },
              },
            }),
          },
          {
            orders: {
              view: {
                fields: ({ f: fields }: FieldsArgs) => ({
                  id: fields.string().primaryKey().notPersonal(),
                  lines: fields.json<string[]>(),
                }),
              },
              queries: {
                getOrder: { payload: ({ z }: EventPayloadArgs) => z.object({ id: z.string() }) },
              },
            },
          },
        ),
      ),
    ).not.toThrow();
  });

  it("refuses to start while a field that can hold text is left undecided, naming each", () => {
    expect(() =>
      checkClassification(
        registry(
          {
            order: aggregate({
              events: {
                orderNoted: {
                  payload: ({ z }: EventPayloadArgs) =>
                    z.object({ note: z.string(), total: z.number() }),
                },
                orderTagged: { payload: ({ z }: EventPayloadArgs) => z.string() },
                orderFlagged: {
                  payload: ({ z }: EventPayloadArgs) => z.looseObject({ flag: z.boolean() }),
                },
              },
              commands: {
                noteOrder: {
                  module: {
                    payload: ({ z }: CommandPayloadArgs) => z.object({ orderId: z.uuid() }),
                  },
                },
              },
              processes: {
                lifecycle: {
                  module: {
                    state: ({ z }: ProcessStateArgs) =>
                      z.object({ step: z.string().nullable().default(null) }),
                  },
                },
              },
            }),
          },
          {
            orders: {
              view: {
                fields: ({ f: fields }: FieldsArgs) => ({ id: fields.string().primaryKey() }),
              },
            },
          },
        ),
      ),
    ).toThrow(
      new ConfigurationError(
        [
          "Every field that can hold text is marked personal, person or notPersonal:",
          "  order.OrderNoted: field note can hold text; mark it personal(), person() or notPersonal()",
          "  order.OrderTagged is not an object, so no mark reaches the text it holds; make it z.object({ ... })",
          "  order.OrderFlagged keeps keys it does not declare, which no mark reaches; use z.object or z.strictObject",
          "  order.noteOrder: field orderId can hold text; mark it personal(), person() or notPersonal()",
          "  order.lifecycle: field step can hold text; mark it personal(), person() or notPersonal()",
          "  Read model orders: column id can hold text; mark it .personal(), .person() or .notPersonal()",
        ].join("\n"),
      ),
    );
  });
});

describe("an app with a field left undecided", () => {
  it("does not start", async () => {
    await expect(
      createTestApp({
        registry: {
          aggregates: {
            order: {
              events: {
                orderNoted: {
                  payload: ({ z }: EventPayloadArgs) => z.object({ note: z.string() }),
                  evolve: () => ({}),
                },
              },
              commands: {},
              policies: {},
              processes: {},
            },
          },
          readModels: {},
        } as unknown as Registry,
      }),
    ).rejects.toThrow(
      "order.OrderNoted: field note can hold text; mark it personal(), person() or notPersonal()",
    );
  });
});
