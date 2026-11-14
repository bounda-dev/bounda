import { type Adapter, isAdapter } from "../adapter/adapter.ts";
import type { InspectedStore, InspectedTable } from "../adapter/storage/inspection.ts";
import type { SealedValue } from "../adapter/storage/personal-key-store.ts";
import type { BoundaClient } from "../kernel/app.ts";
import { isSealed, unseal } from "../kernel/personal-data/crypto.ts";
import { leavesIn, needlesOf } from "../kernel/shared/value-search.ts";
import { testAppsOf } from "./expect-forgotten.ts";
import {
  type FoundValue,
  findIn,
  outsidePlaces,
  type Place,
  placesOfTable,
  rowOfTable,
} from "./places.ts";
import type { TelemetryRecording } from "./telemetry.ts";
import type { TestWitness } from "./witness.ts";

/**
 * Where `expectRedacted` found a value a redaction should have made unreadable.
 */
export type RedactedValueFound = FoundValue;

/**
 * What `expectRedacted` rejects with when an old value can still be read. Its message lists every
 * place and says what to do about each kind.
 */
export class NotRedactedError extends Error {
  readonly personId: string;
  readonly found: readonly RedactedValueFound[];

  constructor(personId: string, found: readonly RedactedValueFound[], advice: readonly string[]) {
    super(
      [
        `A value redacted of person "${personId}" can still be read: ${found.length} ${found.length === 1 ? "place holds" : "places hold"} it.`,
        ...found.map(
          ({ value, store, row, field }) => `  - "${value}" in ${store}, ${row}, ${field}`,
        ),
        "What to do:",
        ...advice.map((line) => `  - ${line}`),
      ].join("\n"),
    );
    this.name = "NotRedactedError";
    this.personId = personId;
    this.found = found;
  }
}

/**
 * What `expectRedacted` searches for and where, beyond what it finds on its own.
 */
export interface ExpectRedactedOptions {
  /**
   * More values that must be read nowhere: what was derived from a redacted value, which only the
   * test can name. Against an adapter, these are all it looks for.
   */
  readonly values?: readonly unknown[];
  /**
   * The spans recorded while the test ran, from `recordTelemetry()`.
   */
  readonly telemetry?: TelemetryRecording;
  /**
   * More places to search, each under the name the report gives it: what a test double of a port
   * was sent, a log of your own.
   */
  readonly places?: Readonly<Record<string, unknown>>;
}

/**
 * The app `createTestApp` returned, or an adapter.
 */
export type ExpectRedactedTarget = Pick<BoundaClient, "exportPersonalData"> | Adapter;

export interface ExpectRedactedFunction {
  (target: ExpectRedactedTarget, personId: string, options?: ExpectRedactedOptions): Promise<void>;
}

const LOGS_ADVICE =
  "A log entry quotes the value, and a log cannot be corrected: log ids, never the data itself.";

const SPANS_ADVICE =
  "A span carries the value to the tracing backend, where it cannot be corrected: put ids in attributes and errors, never the data itself.";

const OTHERWISE =
  "Find where the value is written in the clear and mark the field it comes from personal(), so a redaction reaches it.";

const SEALED_ADVICE =
  "A value sealed under a key the person still holds reads as the old one: redact that field of its event too, which the person's export lists, or the field of the command it came in.";

const STORE_ADVICE: Readonly<Partial<Record<InspectedStore, string>>> = {
  readModel:
    "A read model keeps the value in the clear: mark the field .personal(), so a redaction writes null over what holds the old value, or project the event that corrects it.",
  events:
    "An event holds the value in a field left unmarked: mark it personal() in the event's payload, or the process state's, so a redaction reaches it.",
  scheduledCommands:
    "A stored command holds the value in a field left unmarked: mark it personal() in the command's payload.",
  deadLetters:
    "A dead letter holds the value in the clear: mark the field of the command's payload personal(), or name the person whose data the failed work read, and keep personal data out of error messages.",
  idempotencyKeys:
    "A remembered answer quotes the value: keep personal data out of a rejection's message and say what went wrong with its code and ids.",
  snapshots:
    "A snapshot holds the value from a field left unmarked: mark it personal() where the state's value comes from.",
  subscriberFailures:
    "A subscriber's last failure quotes the value in the clear: mark the field the value comes from personal(), and keep personal data out of error messages.",
};

const adviceOf = (store: InspectedStore | null): string =>
  (store === null ? undefined : STORE_ADVICE[store]) ?? OTHERWISE;

const parsed = (text: string): unknown => {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

// Every envelope a stored value holds, however deep, a JSON document kept as text included.
const envelopesIn = (value: unknown, into: SealedValue[]): void => {
  if (typeof value === "string") {
    const inner = parsed(value);
    if (inner !== undefined) envelopesIn(inner, into);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (isSealed(value)) {
    into.push(value);
    return;
  }
  for (const inner of Object.values(value)) envelopesIn(inner, into);
};

// What an envelope opens to under the keys its person holds now, an envelope sealed inside it
// opened in turn; `undefined` once one of them is gone.
const openedNow = async (
  sealed: SealedValue,
  witness: TestWitness,
  held: ReadonlySet<string>,
): Promise<unknown> => {
  const { person, key: fingerprint } = sealed.$personal;
  const key = witness.keyOf(person, fingerprint);
  if (key === null || !held.has(JSON.stringify([person, fingerprint]))) return undefined;
  const value = await unseal({ key, sealed });
  return isSealed(value) ? openedNow(value, witness, held) : value;
};

// The rows' sealed values the keys held now still open: a value sealed under a key the person
// holds is readable, however it is stored.
const sealedPlaces = async (
  tables: readonly InspectedTable[],
  witness: TestWitness,
): Promise<readonly Place[]> => {
  const held = new Set(
    tables
      .filter((table) => table.store === "personalKeys")
      .flatMap((table) =>
        table.rows.map((row) => JSON.stringify([String(row.person), String(row.fingerprint)])),
      ),
  );
  const places: Place[] = [];
  for (const table of tables) {
    for (const [index, row] of table.rows.entries()) {
      for (const [column, value] of Object.entries(row)) {
        if (table.opaque.includes(column)) continue;
        const envelopes: SealedValue[] = [];
        envelopesIn(value, envelopes);
        for (const envelope of envelopes) {
          const opened = await openedNow(envelope, witness, held);
          if (opened === undefined) continue;
          places.push({
            store: table.name,
            row: rowOfTable(table, row, index),
            leaves: leavesIn(opened).map((leaf) => ({
              ...leaf,
              path: [`${column} (sealed)`, ...leaf.path],
            })),
            advice: SEALED_ADVICE,
          });
        }
      }
    }
  }
  return places;
};

/**
 * Checks that what a person's redactions made unreadable can be read nowhere: rejects with a
 * `NotRedactedError` that lists where each value turned up, and what to do about it, and resolves
 * when there is none.
 *
 * Given the app `createTestApp` returned, it looks for every value the app's redactions of the
 * person sealed for good, as each read before, and adds `values`. It searches each table of the
 * storage and of every read model as stored, the forget ledger, every entry the app logged and,
 * with `telemetry`, every span, as `expectForgotten` does; and it opens every value stored
 * sealed that a key the person, or anyone, still holds opens, so a copy in an event, a command or
 * a read model that was not redacted is found too. Given an adapter, it searches that adapter's
 * tables as stored for `values` alone. A value is matched as `expectForgotten` matches one.
 * Rejects with an `Error` when it has nothing to look for. Works with any test runner.
 */
export const expectRedacted: ExpectRedactedFunction = async (target, personId, options = {}) => {
  const apps = testAppsOf(target);
  if (apps === undefined && !isAdapter(target)) {
    throw new TypeError(
      "expectRedacted takes the app createTestApp returned, or an adapter: for an app built otherwise, pass its storage adapter with the values to look for",
    );
  }
  if (apps?.stopped() === true) {
    throw new Error(
      "expectRedacted reads what the app keeps, so call it before app.stop(): an in-memory database is gone once the app stops",
    );
  }
  const adapters = apps?.adapters ?? [target as Adapter];
  const tables = (await Promise.all(adapters.map((adapter) => adapter.inspect()))).flat();
  const needles = needlesOf({
    values: [...(apps?.witness.redactedFor(personId) ?? []), ...(options.values ?? [])],
    personId,
  });
  if (needles.length === 0) {
    throw new Error(
      `expectRedacted found no redacted value of "${personId}" to look for: redact a field of theirs first, or pass the old values as values`,
    );
  }
  const places: Place[] = [
    ...tables.flatMap((table) => placesOfTable(table, adviceOf)),
    ...(apps === undefined ? [] : await sealedPlaces(tables, apps.witness)),
    ...(await outsidePlaces({
      logs: apps?.witness.logs ?? [],
      ledgers: apps?.ledgers ?? [],
      telemetry: options.telemetry,
      places: options.places,
      errorText: apps?.errorTextChosen ?? true,
      advice: { logs: LOGS_ADVICE, spans: SPANS_ADVICE, otherwise: OTHERWISE },
    })),
  ];
  const { found, advice } = findIn(places, needles);
  if (found.length > 0) throw new NotRedactedError(personId, found, advice);
};
