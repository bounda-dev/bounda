import { describe, expect, it } from "vitest";
import { pendingEvent } from "../testing/fixtures.ts";
import { postgresqlDialect, sqliteDialect } from "./dialect.ts";
import { createKnownEventTypes, insertEventTypesStatements } from "./event-types.ts";

const placed = { aggregateType: "order", type: "OrderPlaced", schemaVersion: 1 };
const paid = { aggregateType: "order", type: "OrderPaid", schemaVersion: 1 };

describe("createKnownEventTypes", () => {
  it("names each type of a batch once, until it is recorded", () => {
    const known = createKnownEventTypes();
    const events = [
      pendingEvent({ aggregateId: "1", version: 1 }),
      pendingEvent({ aggregateId: "1", version: 2 }),
      pendingEvent({ aggregateId: "1", version: 3, type: "OrderPaid" }),
      pendingEvent({ aggregateId: "1", version: 4, schemaVersion: 2 }),
    ];
    expect(known.unseen(events)).toEqual([placed, paid, { ...placed, schemaVersion: 2 }]);
    known.recorded([placed]);
    expect(known.unseen(events)).toEqual([paid, { ...placed, schemaVersion: 2 }]);
    known.recorded([paid, { ...placed, schemaVersion: 2 }]);
    expect(known.unseen(events)).toEqual([]);
  });

  it("counts what a transaction's stores record only once it commits, and never when it does not", () => {
    const known = createKnownEventTypes();
    const events = [pendingEvent({ aggregateId: "1", version: 1 })];
    const rolledBack = known.pending();
    rolledBack.recorded(rolledBack.unseen(events));
    expect(known.unseen(events)).toEqual([placed]);
    const committed = known.pending();
    committed.recorded(committed.unseen(events));
    expect(committed.unseen(events)).toEqual([placed]);
    committed.commit();
    expect(known.unseen(events)).toEqual([]);
    expect(committed.unseen(events)).toEqual([]);
    committed.commit();
    expect(known.unseen(events)).toEqual([]);
  });
});

describe("insertEventTypesStatements", () => {
  it("writes nothing for no types", () => {
    expect(insertEventTypesStatements({ dialect: sqliteDialect, table: '"t"', types: [] })).toEqual(
      [],
    );
  });

  it("binds three numbered parameters a type, leaving types already there as they are", () => {
    expect(
      insertEventTypesStatements({
        dialect: postgresqlDialect,
        table: '"t"',
        types: [placed, paid],
      }),
    ).toEqual([
      {
        sql: 'INSERT INTO "t" ("aggregate_type", "type", "schema_version") VALUES ($1, $2, $3), ($4, $5, $6) ON CONFLICT DO NOTHING',
        params: ["order", "OrderPlaced", 1, "order", "OrderPaid", 1],
      },
    ]);
  });

  it("splits types over statements of at most a hundred parameters", () => {
    const types = Array.from({ length: 34 }, (_, index) => ({ ...placed, schemaVersion: index }));
    const statements = insertEventTypesStatements({
      dialect: postgresqlDialect,
      table: '"t"',
      types,
    });
    expect(statements.map(({ params }) => params.length)).toEqual([99, 3]);
    expect(statements[1]).toEqual({
      sql: 'INSERT INTO "t" ("aggregate_type", "type", "schema_version") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      params: ["order", "OrderPlaced", 33],
    });
    expect(statements[0]?.sql).toContain("($97, $98, $99) ON CONFLICT");
  });
});
