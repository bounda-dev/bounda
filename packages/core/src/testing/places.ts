import type { ForgetLedger, ForgetLedgerEntry } from "../adapter/storage/forget-ledger.ts";
import type { InspectedStore, InspectedTable } from "../adapter/storage/inspection.ts";
import { type Leaf, leavesIn, matches, type Needle } from "../kernel/shared/value-search.ts";
import type { TelemetryRecording } from "./telemetry.ts";
import type { LoggedEntry } from "./witness.ts";

/**
 * Where a value of a person turned up.
 */
export interface FoundValue {
  readonly value: string;
  readonly store: string;
  readonly row: string;
  readonly field: string;
}

/**
 * Somewhere a search looks: a row, a log entry, a span, with what to do about a value found there.
 */
export interface Place {
  readonly store: string;
  readonly row: string;
  readonly leaves: readonly Leaf[];
  readonly advice: string;
}

const rowOf = (table: InspectedTable, row: Readonly<Record<string, unknown>>, index: number) =>
  table.key.length === 0
    ? `row ${index + 1}`
    : table.key.map((column) => `${column}=${String(row[column])}`).join(", ");

export interface PlacesOfTableFunction {
  (table: InspectedTable, adviceOf: (store: InspectedStore | null) => string): readonly Place[];
}

export const placesOfTable: PlacesOfTableFunction = (table, adviceOf) =>
  table.rows.map((row, index) => ({
    store: table.name,
    row: rowOf(table, row, index),
    advice: adviceOf(table.store),
    leaves: Object.entries(row).flatMap(([column, value]) =>
      leavesIn(value, table.opaque.includes(column)).map((leaf) => ({
        ...leaf,
        path: [column, ...leaf.path],
      })),
    ),
  }));

export interface RowOfTableFunction {
  (table: InspectedTable, row: Readonly<Record<string, unknown>>, index: number): string;
}

export const rowOfTable: RowOfTableFunction = rowOf;

export interface PathOfFunction {
  (path: readonly string[]): string;
}

export const pathOf: PathOfFunction = (path) =>
  path.reduce(
    (joined, step) => (step.startsWith("[") || joined === "" ? joined + step : `${joined}.${step}`),
    "",
  );

// Where the runtime writes the text of an error: the fields of a log entry, and the attributes of a
// span's exception event under OpenTelemetry's conventions, besides the span's status message.
const LOG_ERROR_TEXT = new Set(["errorMessage", "errorStack"]);
const SPAN_ERROR_TEXT = new Set(["exception.message", "exception.stacktrace"]);

const LEDGER_PAGE = 500;

export interface LedgerEntriesFunction {
  (ledger: ForgetLedger): Promise<readonly ForgetLedgerEntry[]>;
}

export const ledgerEntries: LedgerEntriesFunction = async (ledger) => {
  const entries: ForgetLedgerEntry[] = [];
  for (;;) {
    const last = entries.at(-1);
    const page = await ledger.read({
      limit: LEDGER_PAGE,
      ...(last === undefined ? {} : { after: last }),
    });
    entries.push(...page);
    if (page.length < LEDGER_PAGE) return entries;
  }
};

export interface OutsidePlacesArgs {
  readonly logs: readonly LoggedEntry[];
  readonly ledgers: readonly ForgetLedger[];
  readonly telemetry: TelemetryRecording | undefined;
  readonly places: Readonly<Record<string, unknown>> | undefined;
  /**
   * Whether the text of errors in logs and spans is searched: only when the test chose
   * `runtime.telemetry.errorText` itself.
   */
  readonly errorText: boolean;
  readonly advice: {
    readonly logs: string;
    readonly spans: string;
    readonly otherwise: string;
  };
}

export interface OutsidePlacesFunction {
  (args: OutsidePlacesArgs): Promise<readonly Place[]>;
}

/**
 * The places beside the tables: the app's logs, the forget ledger, the spans recorded and those
 * the test adds.
 */
export const outsidePlaces: OutsidePlacesFunction = async ({
  logs,
  ledgers,
  telemetry,
  places: given,
  errorText,
  advice,
}) => {
  const places: Place[] = [];
  logs.forEach((entry, index) => {
    places.push({
      store: "logs",
      row: `entry ${index + 1} (${entry.level} "${entry.message}")`,
      leaves: leavesIn({ message: entry.message, fields: entry.fields ?? {} }).filter(
        (leaf) => errorText || !LOG_ERROR_TEXT.has(leaf.path[1] ?? ""),
      ),
      advice: advice.logs,
    });
  });
  for (const ledger of ledgers) {
    for (const entry of await ledgerEntries(ledger)) {
      places.push({
        store: "forget ledger",
        row: `eventId=${entry.eventId}`,
        leaves: leavesIn(entry),
        advice: advice.otherwise,
      });
    }
  }
  telemetry?.spans.forEach((span, index) => {
    places.push({
      store: "spans",
      row: `span ${index + 1} ("${span.name}")`,
      leaves: leavesIn(span).filter(
        (leaf) => errorText || !(leaf.path[0] === "status" && leaf.path[1] === "message"),
      ),
      advice: advice.spans,
    });
  });
  telemetry?.spanEvents.forEach((event, index) => {
    places.push({
      store: "span events",
      row: `event ${index + 1} ("${event.name}" of "${event.span}")`,
      leaves: leavesIn(event).filter(
        (leaf) => errorText || !SPAN_ERROR_TEXT.has(leaf.path[1] ?? ""),
      ),
      advice: advice.spans,
    });
  });
  for (const [store, value] of Object.entries(given ?? {})) {
    places.push({ store, row: "as given", leaves: leavesIn(value), advice: advice.otherwise });
  }
  return places;
};

export interface FindIn {
  readonly found: readonly FoundValue[];
  readonly advice: readonly string[];
}

export interface FindInFunction {
  (places: readonly Place[], needles: readonly Needle[]): FindIn;
}

/**
 * Every needle found in the places, with the advice of each place it was found in, once each.
 */
export const findIn: FindInFunction = (places, needles) => {
  const advice = new Set<string>();
  const found = places.flatMap((place) =>
    place.leaves.flatMap((leaf) =>
      needles
        .filter((needle) => matches(needle, leaf))
        .map((needle) => {
          advice.add(place.advice);
          return {
            value: needle.value,
            store: place.store,
            row: place.row,
            field: pathOf(leaf.path) || "value",
          };
        }),
    ),
  );
  return { found, advice: [...advice] };
};
