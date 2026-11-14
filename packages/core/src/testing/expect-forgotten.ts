import { type Adapter, isAdapter } from "../adapter/adapter.ts";
import type { ForgetLedger } from "../adapter/storage/forget-ledger.ts";
import type { InspectedStore, InspectedTable } from "../adapter/storage/inspection.ts";
import { DEFAULT_PERSONAL_CATEGORY } from "../adapter/storage/personal-key-store.ts";
import type { BoundaClient } from "../kernel/app.ts";
import { categoryOf, unseal } from "../kernel/personal-data/crypto.ts";
import type { PersonalDataExport } from "../kernel/personal-data/export.ts";
import { needlesOf } from "../kernel/shared/value-search.ts";
import type { PersonalCategoryName } from "../modules/personal-data.ts";
import { findIn, outsidePlaces, type Place, placesOfTable } from "./places.ts";
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
  /**
   * Checks only these categories, as after `forget(personId, { categories })`: what was sealed or
   * kept of the person in them, and the fields of `before` in them, are looked for, and the
   * person must hold no key in force of them. Without it, every category the person no longer
   * holds a key of.
   */
  readonly categories?: readonly PersonalCategoryName[];
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

export interface TestApps {
  readonly witness: TestWitness;
  readonly adapters: readonly Adapter[];
  /**
   * Whether `app.stop()` ran: an in-memory database is gone then, and a ledger closed.
   */
  readonly stopped: () => boolean;
  /**
   * Whether the test's configuration chose `runtime.telemetry.errorText`. When it did not, the
   * text of errors in logs and spans is there only because a test app includes it, and an app
   * outside a test does not write it, so it is not searched.
   */
  readonly errorTextChosen: boolean;
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

export interface TestAppsOfFunction {
  (target: object): TestApps | undefined;
}

/**
 * What the app `createTestApp` returned was seen doing, `undefined` for anything else.
 */
export const testAppsOf: TestAppsOfFunction = (target) => witnessed.get(target);

interface ExportedRecord {
  readonly data: Readonly<Record<string, unknown>>;
  readonly categories: Readonly<Record<string, string>>;
}

// The fields of each record, of the categories asked for alone when they are.
const exportedValues = (
  exported: PersonalDataExport,
  categories: readonly string[] | undefined,
): readonly unknown[] => {
  const records: readonly ExportedRecord[] = [
    ...exported.events,
    ...exported.scheduledCommands,
    ...exported.deadLetters,
    ...Object.values(exported.readModels).flat(),
  ];
  return records.map(({ data, categories: of }) =>
    categories === undefined
      ? data
      : Object.fromEntries(
          Object.entries(data).filter(([field]) =>
            categories.includes(of[field] ?? DEFAULT_PERSONAL_CATEGORY),
          ),
        ),
  );
};

const LOGS_ADVICE =
  "A log entry quotes the value, and a log cannot be forgotten: log ids, never the data itself.";

const SPANS_ADVICE =
  "A span carries the value to the tracing backend, where it cannot be forgotten: put ids in attributes and errors, never the data itself.";

const OTHERWISE =
  "Find where the value is written in the clear and mark the field it comes from, or remove it when the person is forgotten.";

const adviceOf = (store: InspectedStore | null): string =>
  (store === null ? undefined : STORE_ADVICE[store]) ?? OTHERWISE;

const STORE_ADVICE: Readonly<Partial<Record<InspectedStore, string>>> = {
  readModel:
    "A read model kept the value: mark the field .personal(), which seals it under the person's key; for a field kept in the clear with .personal({ clear: true }), project PersonalDataForgotten and delete the row or clear the field.",
  events:
    "An event holds the value in a field left unmarked: mark it personal() in the event's payload, or the process state's.",
  scheduledCommands:
    "A stored command holds the value in a field left unmarked: mark it personal() in the command's payload.",
  deadLetters:
    "A dead letter holds the value: mark the field of the command's payload personal(), or name the person whose data the failed work read, and keep personal data out of error messages.",
  idempotencyKeys:
    "A remembered answer quotes the value: keep personal data out of a rejection's message and say what went wrong with its code and ids.",
  snapshots:
    "A snapshot holds the value from a field left unmarked: mark it personal() where the state's value comes from.",
  subscriberFailures:
    "A subscriber's last failure quotes the value in the clear: its event names the person by no marked field holding a value, so mark the field the value comes from personal(), and keep personal data out of error messages.",
};

const opened = async (
  witness: TestWitness,
  personId: string,
  held: ReadonlySet<string>,
  categories: readonly string[] | undefined,
) => {
  const values: unknown[] = [];
  for (const { envelope, key } of witness.sealedFor(personId)) {
    if (held.has(envelope.key)) continue;
    if (categories !== undefined && !categories.includes(categoryOf({ $personal: envelope }))) {
      continue;
    }
    if (key === null) {
      throw new Error(
        `expectForgotten saw a value of "${personId}" sealed under a key the test app never held; report this as a bug in Bounda`,
      );
    }
    values.push(await unseal({ key, sealed: { $personal: envelope } }));
  }
  return values;
};

interface HeldKeys {
  /**
   * The fingerprints of every key the person holds, in force or kept past a forgetting: what was
   * sealed under one is theirs still, or kept lawfully.
   */
  readonly fingerprints: ReadonlySet<string>;
  /**
   * The categories of the keys they hold in force.
   */
  readonly inForce: ReadonlySet<string>;
}

const heldKeys = (tables: readonly InspectedTable[], personId: string): HeldKeys => {
  const rows = tables
    .filter((table) => table.store === "personalKeys")
    .flatMap((table) => table.rows.filter((row) => row.person === personId));
  return {
    fingerprints: new Set(rows.map((row) => String(row.fingerprint))),
    inForce: new Set(
      rows
        .filter((row) => row.retained_since === null || row.retained_since === undefined)
        .map((row) => String(row.category ?? DEFAULT_PERSONAL_CATEGORY)),
    ),
  };
};

/**
 * Checks that nothing a person had is left readable once they are forgotten: rejects with a
 * `NotForgottenError` that lists where each value turned up, and what to do about it, and
 * resolves when there is none.
 *
 * Given the app `createTestApp` returned, it looks for every value of a field marked
 * `personal()` that the app sealed under a key the person no longer holds, and for every value a
 * read model kept in a field marked `.personal()` for them before its category was forgotten, and
 * adds `values` and `before`; with `categories`, those of the categories named alone. A key a
 * legal obligation kept past the forgetting is still held, so what it sealed is not looked for. It searches each table of the storage and of every read model, read as
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
  if (apps?.stopped() === true) {
    throw new Error(
      "expectForgotten reads what the app keeps, so call it before app.stop(): an in-memory database is gone once the app stops",
    );
  }
  const adapters = apps?.adapters ?? [target as Adapter];
  const tables = (await Promise.all(adapters.map((adapter) => adapter.inspect()))).flat();
  if (tables.length === 0) {
    throw new Error(
      "expectForgotten found no table to search: the adapter's database holds none of Bounda's, so it may be another one, or closed",
    );
  }
  // Names, whatever the project registers, so any category read from the store compares.
  const categories: readonly string[] | undefined = options.categories;
  const held = heldKeys(tables, personId);
  const stillHeld = [...held.inForce].filter(
    (category) => categories === undefined || categories.includes(category),
  );
  if (categories !== undefined && stillHeld.length > 0) {
    throw new Error(
      `"${personId}" still holds a key in force of ${stillHeld.map((category) => `"${category}"`).join(", ")}: forget those categories before expectForgotten`,
    );
  }
  const values: unknown[] = [...(options.values ?? [])];
  if (options.before !== undefined) values.push(...exportedValues(options.before, categories));
  if (apps !== undefined) {
    values.push(...(await opened(apps.witness, personId, held.fingerprints, categories)));
    values.push(...apps.witness.keptFor(personId, categories));
  }
  const needles = needlesOf({ values, personId });
  if (needles.length === 0) {
    throw new Error(
      stillHeld.length === 0
        ? `expectForgotten found no value of "${personId}" to look for: pass the ones the test gave them as values, or their export as before`
        : `"${personId}" still holds a key: forget them before expectForgotten, which looks only for what was sealed under keys they no longer hold`,
    );
  }

  const places: Place[] = [
    ...tables.flatMap((table) => placesOfTable(table, adviceOf)),
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
  if (found.length > 0) throw new NotForgottenError(personId, found, advice);
};
