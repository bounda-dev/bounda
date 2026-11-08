import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigurationError } from "../../contracts/errors.ts";
import { person, personal } from "../../modules/personal.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { marksPersonalFields, type PersonalMarks, personalMarksOf } from "./marks.ts";

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

  it("names the person of a payload without personal fields, which nothing encrypts", () => {
    const schema = z.object({ customerId: person(z.string()), total: z.number() });
    expect(personalMarksOf({ schema, path })).toEqual({ person: "customerId", fields: [] });
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

describe("marksPersonalFields", () => {
  const aggregates = (
    events: readonly (PersonalMarks | null)[],
    commands: readonly (PersonalMarks | null)[],
  ): AggregatesRuntime =>
    ({
      byName: {
        customer: {
          eventsByType: Object.fromEntries(
            events.map((personal, index) => [`E${index}`, { personal }]),
          ),
          commands: Object.fromEntries(
            commands.map((personal, index) => [`c${index}`, { personal }]),
          ),
        },
        other: { eventsByType: {}, commands: {} },
      },
      commandsByType: {},
    }) as unknown as AggregatesRuntime;
  const processes = (states: readonly (PersonalMarks | null)[]): ProcessesRuntime =>
    ({ all: states.map((personal) => ({ personal })) }) as unknown as ProcessesRuntime;
  const fields = { person: null, fields: ["email"] };
  const personOnly = { person: "customerId", fields: [] };
  const marks = (
    events: readonly (PersonalMarks | null)[],
    commands: readonly (PersonalMarks | null)[],
    states: readonly (PersonalMarks | null)[] = [],
  ): boolean =>
    marksPersonalFields({ aggregates: aggregates(events, commands), processes: processes(states) });

  it("is true when an event, a command or a process state marks a field personal", () => {
    expect(marks([null, fields], [])).toBe(true);
    expect(marks([], [null, fields])).toBe(true);
    expect(marks([fields], [null])).toBe(true);
    expect(marks([], [], [null, fields])).toBe(true);
  });

  it("is false when nothing is marked, or only whom a payload touches", () => {
    expect(marks([], [])).toBe(false);
    expect(marks([null, personOnly], [null, personOnly], [null, personOnly])).toBe(false);
  });
});
