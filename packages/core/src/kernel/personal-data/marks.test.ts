import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigurationError } from "../../contracts/errors.ts";
import { person, personal } from "../../modules/personal.ts";
import { personalMarksOf } from "./marks.ts";

const path = "aggregates.order.events.orderPlaced";

describe("personalMarksOf", () => {
  it("is null for an event without a payload or without personal fields", () => {
    expect(personalMarksOf({ schema: null, path })).toBeNull();
    expect(personalMarksOf({ schema: z.object({ total: z.number() }), path })).toBeNull();
    expect(personalMarksOf({ schema: z.string(), path })).toBeNull();
  });

  it("lists the personal fields, with the person the aggregate's id names when none is marked", () => {
    const schema = z.object({
      total: z.number(),
      email: personal(z.email()),
      address: personal(z.object({ street: z.string() })).optional(),
      phone: personal(z.string()).nullable().default(null),
      name: personal(z.string()).transform((value) => value?.trim()),
    });
    expect(personalMarksOf({ schema, path })).toEqual({
      person: null,
      fields: ["email", "address", "phone", "name"],
    });
  });

  it("names the person field, however it is wrapped", () => {
    const schema = z.object({
      customerId: person(z.uuid()).readonly(),
      note: personal(z.string()),
    });
    expect(personalMarksOf({ schema, path })).toEqual({ person: "customerId", fields: ["note"] });
  });

  it("finds no mark deeper than the top level of the payload", () => {
    const schema = z.object({ contact: z.object({ email: personal(z.email()) }) });
    expect(personalMarksOf({ schema, path })).toBeNull();
  });

  it("is null for a person without personal fields, which nothing encrypts", () => {
    const schema = z.object({ customerId: person(z.string()), total: z.number() });
    expect(personalMarksOf({ schema, path })).toBeNull();
  });

  it("refuses two person fields", () => {
    const schema = z.object({
      buyerId: person(z.string()),
      sellerId: person(z.string()),
      email: personal(z.email()),
    });
    expect(() => personalMarksOf({ schema, path })).toThrow(
      new ConfigurationError(
        `${path}: marks "buyerId" and "sellerId" with person; a payload names at most one person`,
      ),
    );
  });
});
