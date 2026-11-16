import { describe, expect, it } from "vitest";
import { z } from "zod";
import { notPersonal, person, personal } from "../../modules/personal.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
import { processStateArgs } from "../process/deadlines.ts";
import { classifySchema, classifyView, holdsText } from "./classification.ts";

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
