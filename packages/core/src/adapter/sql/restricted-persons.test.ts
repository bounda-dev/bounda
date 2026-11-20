import { describe, expect, it } from "vitest";
import { fieldBuilder as f } from "../../modules/view.ts";
import { storedFields } from "../storage/sealed-fields.ts";
import { postgresqlDialect } from "./dialect.ts";
import {
  createSqlRestrictedReads,
  restrictedRowsCondition,
  retainedRowsCondition,
} from "./restricted-persons.ts";

const COPY = '"bounda_restricted_persons"';

describe("the conditions on who is restricted, on PostgreSQL", () => {
  it("bind their values from the offset they are given", () => {
    expect(
      restrictedRowsCondition({
        restrictedPersons: COPY,
        person: '"t"."customer_id"',
        categories: ["profile"],
        dialect: postgresqlDialect,
      })(2),
    ).toEqual({
      sql: `NOT EXISTS (SELECT 1 FROM ${COPY} WHERE ${COPY}."person" = "t"."customer_id" AND ${COPY}."category" IN ($3, $4))`,
      params: ["", "profile"],
    });
    expect(
      retainedRowsCondition({ keys: ['"t"."a__key"', '"t"."b__key"'], dialect: postgresqlDialect })(
        3,
      ),
    ).toEqual({
      sql: '("t"."a__key" IS NULL OR "t"."a__key" NOT LIKE $4) AND ("t"."b__key" IS NULL OR "t"."b__key" NOT LIKE $5)',
      params: ["retained:%", "retained:%"],
    });
  });

  it("render for hand-written SQL with every value a literal, a category with a backslash as an escape string", () => {
    const reads = createSqlRestrictedReads({
      readModel: "notes",
      table: "bounda_rm_notes",
      fields: storedFields({
        readModel: "notes",
        fields: {
          noteId: f.string().primaryKey(),
          customerId: f.string().index().person(),
          text: f.string().optional().personal({ category: "it's \\ odd" }),
        },
      }),
      dialect: postgresqlDialect,
      executor: { run: async () => undefined, all: async () => [] },
      restrictedPersons: COPY,
    });
    const requested = (person: string) =>
      `NOT EXISTS (SELECT 1 FROM ${COPY} WHERE ${COPY}."person" = ${person} AND ${COPY}."category" IN ('', E'it''s \\\\ odd'))`;
    expect(reads.condition("unrestricted")).toBe(
      `(${requested('"bounda_rm_notes"."customer_id"')} AND ("bounda_rm_notes"."text__key" IS NULL OR "bounda_rm_notes"."text__key" NOT LIKE 'retained:%'))`,
    );
    expect(reads.condition("retained", "n")).toBe(`(${requested('n."customer_id"')})`);
    expect(reads.condition("all", "n")).toBe(
      '(n."customer_id" IS NULL OR n."customer_id" IS NOT NULL)',
    );
  });
});
