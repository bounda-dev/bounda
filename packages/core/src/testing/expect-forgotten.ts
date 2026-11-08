import { type Adapter, isAdapter } from "../adapter/adapter.ts";
import type { ForgetLedger, ForgetLedgerEntry } from "../adapter/storage/forget-ledger.ts";
import type { InspectedTable } from "../adapter/storage/inspection.ts";
import type { BoundaClient } from "../kernel/app.ts";
import { importPersonalKey, unseal } from "../kernel/personal-data/crypto.ts";
import type { PersonalDataExport } from "../kernel/personal-data/export.ts";
import { type Leaf, leavesIn, matches, needlesOf } from "./search.ts";
import type { TelemetryRecording } from "./telemetry.ts";
import type { TestWitness } from "./witness.ts";

/**
 * Where `expectForgotten` found a value of the person.
 */
export interface ForgottenValueFound {
  /**
   * The value found, as it was given or sealed.
   */
  readonly value: string;
  /**
   * Where: a table, as the adapter names it, `logs`, `spans`, `span events`, `forget ledger`, or
   * the name of one of `places`.
   */
  readonly store: string;
  /**
   * Which row, entry or span: its key, as `position=3`.
   */
  readonly row: string;
  /**
   * The column or field, with the path into a JSON document it holds: `payload.note`.
   */
  readonly field: string;
}

/**
 * What `expectForgotten` rejects with when it finds a value of the person. Its message lists
 * every place and says what to do about each kind.
 */
export class NotForgottenError extends Error {
  readonly personId: string;
  readonly found: readonly ForgottenValueFound[];

  constructor(personId: string, found: readonly ForgottenValueFound[], advice: readonly string[]) {
    const lines = found.map(
      ({ value, store, row, field }) => `  - "${value}" in ${store}, ${row}, ${field}`,
    );
    super(
      [
        `Person "${personId}" was not forgotten everywhere: ${found.length} ${found.length === 1 ? "place still holds" : "places still hold"} a value of theirs in the clear.`,
        ...lines,
        "What to do:",
        ...advice.map((line) => `  - ${line}`),
      ].join("\n"),
    );
    this.name = "NotForgottenError";
    this.personId = personId;
    this.found = found;
  }
}

/**
 * What `expectForgotten` searches for and where, beyond what it finds on its own.
 */
export interface ExpectForgottenOptions {
  /**
   * More values of the person: strings and numbers, or objects and arrays holding them. What a
   * projection or a handler derived from their fields, a lowercased email or a formatted phone
   * number, is not sealed anywhere, so only the test can name it. Against an adapter, these and
   * `before` are all it looks for.
   */
  readonly values?: readonly unknown[];
  /**
   * The person's export, taken before they were forgotten: every value it opened is looked for.
   */
  readonly before?: PersonalDataExport;
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
export type ExpectForgottenTarget = Pick<BoundaClient, "forget"> | Adapter;

export interface ExpectForgottenFunction {
  (
    target: ExpectForgottenTarget,
    personId: string,
    options?: ExpectForgottenOptions,
  ): Promise<void>;
}

const witnessed = new WeakMap<object, TestApps>();

interface TestApps {
  readonly witness: TestWitness;
  readonly adapters: readonly Adapter[];
  /**
   * The forget ledger this app opened, which closes with it.
   */
  readonly ledgers: readonly ForgetLedger[];
}

export interface RegisterTestAppFunction {
  (app: object, apps: TestApps): void;
}

export const registerTestApp: RegisterTestAppFunction = (app, apps) => {
  witnessed.set(app, apps);
};

const LEDGER_PAGE = 500;

const ledgerEntries = async (ledger: ForgetLedger): Promise<readonly ForgetLedgerEntry[]> => {
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

const exportedValues = (exported: PersonalDataExport): readonly unknown[] => [
  ...exported.events.map(({ data }) => data),
  ...exported.scheduledCommands.map(({ data }) => data),
  ...exported.deadLetters.map(({ data }) => data),
  ...Object.values(exported.readModels).flatMap((rows) => rows.map(({ data }) => data)),
];

const rowOf = (table: InspectedTable, row: Readonly<Record<string, unknown>>, index: number) =>
  table.key.length === 0
    ? `row ${index + 1}`
    : table.key.map((column) => `${column}=${String(row[column])}`).join(", ");

interface Place {
  readonly store: string;
  readonly row: string;
  readonly leaves: readonly Leaf[];
  /**
   * What to do about a value found here.
   */
  readonly advice: string;
}

const placesOfTable = (table: InspectedTable): readonly Place[] =>
  table.rows.map((row, index) => ({
    store: table.name,
    row: rowOf(table, row, index),
    advice: TABLE_ADVICE.find(({ test }) => test(table.name))?.advice ?? OTHERWISE,
    leaves: Object.entries(row).flatMap(([column, value]) =>
      leavesIn(value, table.opaque.includes(column)).map((leaf) => ({
        ...leaf,
        path: [column, ...leaf.path],
      })),
    ),
  }));

const pathOf = (path: readonly string[]): string =>
  path.reduce(
    (joined, step) => (step.startsWith("[") || joined === "" ? joined + step : `${joined}.${step}`),
    "",
  );

const LOGS_ADVICE =
  "A log entry quotes the value, and a log cannot be forgotten: log ids, never the data itself.";

const SPANS_ADVICE =
  "A span carries the value to the tracing backend, where it cannot be forgotten: put ids in attributes and errors, never the data itself.";

const OTHERWISE =
  "Find where the value is written in the clear and mark the field it comes from, or remove it when the person is forgotten.";

// By the end of a table's name, whatever the adapter's prefix.
const TABLE_ADVICE: readonly {
  readonly test: (table: string) => boolean;
  readonly advice: string;
}[] = [
  {
    test: (table) => /rm_[a-z0-9_]+$/.test(table),
    advice:
      "A read model kept the value: project PersonalDataForgotten in it and delete the row or clear the field, and mark the field .personal() so its export and the access log see it.",
  },
  {
    test: (table) => /events$/.test(table),
    advice:
      "An event holds the value in a field left unmarked: mark it personal() in the event's payload, or the process state's.",
  },
  {
    test: (table) => /scheduled_commands$/.test(table),
    advice:
      "A stored command holds the value in a field left unmarked: mark it personal() in the command's payload.",
  },
  {
    test: (table) => /dead_letters$/.test(table),
    advice:
      "A dead letter holds the value: mark the field of the command's payload personal(), or name the person whose data the failed work read, and keep personal data out of error messages.",
  },
  {
    test: (table) => /idempotency_keys$/.test(table),
    advice:
      "A remembered answer quotes the value: keep personal data out of a rejection's message and say what went wrong with its code and ids.",
  },
  {
    test: (table) => /snapshots$/.test(table),
    advice:
      "A snapshot holds the value from a field left unmarked: mark it personal() where the state's value comes from.",
  },
];

const opened = async (witness: TestWitness, personId: string, held: string | null) => {
  const values: unknown[] = [];
  for (const { envelope, key } of witness.sealedFor(personId)) {
    if (envelope.key === held) continue;
    if (key === null) {
      throw new Error(
        `expectForgotten saw a value of "${personId}" sealed under a key the test app never held; report this as a bug in Bounda`,
      );
    }
    values.push(
      await unseal({ key: await importPersonalKey(key), sealed: { $personal: envelope } }),
    );
  }
  return values;
};

// The fingerprint of the key the person holds now: what was sealed under it is theirs still.
const heldKey = (tables: readonly InspectedTable[], personId: string): string | null => {
  for (const table of tables) {
    if (!table.name.endsWith("personal_keys")) continue;
    const row = table.rows.find((candidate) => candidate.person === personId);
    if (row !== undefined) return String(row.fingerprint);
  }
  return null;
};

/**
 * Checks that nothing a person had is left readable once they are forgotten: rejects with a
 * `NotForgottenError` that lists where each value turned up, and what to do about it, and
 * resolves when there is none.
 *
 * Given the app `createTestApp` returned, it looks for every value of a field marked
 * `personal()` that the app sealed under a key the person no longer holds, and for every value a
 * read model kept in a field marked `.personal()` for them before they were forgotten, and adds
 * `values` and `before`. It searches each table of the storage and of every read model, read as
 * stored and never opened, the forget ledger, every entry the app logged and, with `telemetry`,
 * every span. Given an adapter, such as one over a Durable Object's storage, it searches that
 * adapter's tables for `values` and `before` alone.
 *
 * A value is matched without regard to case, inside any longer text, a JSON document stored as
 * text included; one shorter than `MIN_SUBSTRING_LENGTH` only as a whole word. Key material and
 * ciphertext are compared whole. A value equal to the person's id is never looked for, since ids
 * stay. Rejects with an `Error` when it has nothing to look for, so a test cannot pass for want
 * of values. Works with any test runner.
 */
export const expectForgotten: ExpectForgottenFunction = async (target, personId, options = {}) => {
  const apps = witnessed.get(target);
  if (apps === undefined && !isAdapter(target)) {
    throw new TypeError(
      "expectForgotten takes the app createTestApp returned, or an adapter: for an app built otherwise, pass its storage adapter with the values to look for",
    );
  }
  const adapters = apps?.adapters ?? [target as Adapter];
  const tables = (await Promise.all(adapters.map((adapter) => adapter.inspect()))).flat();
  const held = heldKey(tables, personId);
  const values: unknown[] = [...(options.values ?? [])];
  if (options.before !== undefined) values.push(...exportedValues(options.before));
  if (apps !== undefined) {
    values.push(...(await opened(apps.witness, personId, held)));
    values.push(...apps.witness.keptFor(personId));
  }
  const needles = needlesOf({ values, personId });
  if (needles.length === 0) {
    throw new Error(
      held === null
        ? `expectForgotten found no value of "${personId}" to look for: pass the ones the test gave them as values, or their export as before`
        : `"${personId}" still holds a key: forget them before expectForgotten, which looks only for what was sealed under keys they no longer hold`,
    );
  }

  const places: Place[] = tables.flatMap(placesOfTable);
  if (apps !== undefined) {
    apps.witness.logs.forEach((entry, index) => {
      places.push({
        store: "logs",
        row: `entry ${index + 1} (${entry.level} "${entry.message}")`,
        leaves: leavesIn({ message: entry.message, fields: entry.fields ?? {} }),
        advice: LOGS_ADVICE,
      });
    });
    for (const ledger of apps.ledgers) {
      for (const entry of await ledgerEntries(ledger)) {
        places.push({
          store: "forget ledger",
          row: `eventId=${entry.eventId}`,
          leaves: leavesIn(entry),
          advice: OTHERWISE,
        });
      }
    }
  }
  options.telemetry?.spans.forEach((span, index) => {
    places.push({
      store: "spans",
      row: `span ${index + 1} ("${span.name}")`,
      leaves: leavesIn(span),
      advice: SPANS_ADVICE,
    });
  });
  options.telemetry?.spanEvents.forEach((event, index) => {
    places.push({
      store: "span events",
      row: `event ${index + 1} ("${event.name}" of "${event.span}")`,
      leaves: leavesIn(event),
      advice: SPANS_ADVICE,
    });
  });
  for (const [store, value] of Object.entries(options.places ?? {})) {
    places.push({ store, row: "as given", leaves: leavesIn(value), advice: OTHERWISE });
  }

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
  if (found.length > 0) throw new NotForgottenError(personId, found, [...advice]);
};
