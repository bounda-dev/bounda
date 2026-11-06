import { describe, expect, it } from "vitest";
import { pendingEvent } from "../testing/fixtures.ts";
import { postgresqlDialect, sqliteDialect } from "./dialect.ts";
import { EVENTS_PER_INSERT, insertEventsStatements, positionsByVersion } from "./event-rows.ts";

const events = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    pendingEvent({ aggregateId: "1", version: index + 1, payload: { n: index } }),
  );

describe("insertEventsStatements", () => {
  it("writes every event of one statement as a row, with the engine's placeholders", () => {
    const [statement, ...rest] = insertEventsStatements({
      dialect: postgresqlDialect,
      table: '"events"',
      events: events(2),
      encodeJson: (value) => JSON.stringify(value),
    });
    expect(rest).toEqual([]);
    expect(statement?.sql).toBe(
      'INSERT INTO "events" ("id", "aggregate_type", "aggregate_id", "version", "type", "payload", "timestamp", "metadata") VALUES ($1, $2, $3, $4, $5, $6, $7, $8), ($9, $10, $11, $12, $13, $14, $15, $16) RETURNING "version", "position"',
    );
    expect(statement?.params).toHaveLength(16);
    expect(statement?.params.slice(3, 6)).toEqual([1, "OrderPlaced", '{"n":0}']);
    expect(statement?.params[11]).toBe(2);
    const [sqlite] = insertEventsStatements({
      dialect: sqliteDialect,
      table: '"events"',
      events: events(1),
      encodeJson: (value) => value,
    });
    expect(sqlite?.sql).toContain("VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING");
  });

  it("splits more events than one statement carries, and none when there are none", () => {
    const statements = insertEventsStatements({
      dialect: sqliteDialect,
      table: '"events"',
      events: events(EVENTS_PER_INSERT * 2 + 1),
      encodeJson: (value) => value,
    });
    expect(statements.map(({ params }) => params.length / 8)).toEqual([
      EVENTS_PER_INSERT,
      EVENTS_PER_INSERT,
      1,
    ]);
    expect(statements[2]?.params[3]).toBe(EVENTS_PER_INSERT * 2 + 1);
    expect(
      insertEventsStatements({
        dialect: sqliteDialect,
        table: '"events"',
        events: [],
        encodeJson: (value) => value,
      }),
    ).toEqual([]);
  });

  it("matches positions to versions however the rows come back", () => {
    expect(
      positionsByVersion([
        { version: "2", position: "11" },
        { version: 1, position: 10 },
      ]),
    ).toEqual(
      new Map([
        [2, 11],
        [1, 10],
      ]),
    );
  });
});
