import type { Adapter } from "../adapter/adapter.ts";
import type { InspectedStore, InspectedTable } from "../adapter/storage/inspection.ts";
import { DEFAULT_PERSONAL_CATEGORY } from "../adapter/storage/personal-key-store.ts";
import { TenantForgottenError } from "../contracts/errors.ts";
import { categoryOf, unseal } from "../kernel/personal-data/crypto.ts";
import type { PersonalDataExport } from "../kernel/personal-data/export.ts";
import { needlesOf } from "../kernel/shared/value-search.ts";
import type { Witness } from "../kernel/witness.ts";
import type { PersonalCategoryName } from "../modules/personal-data.ts";
import type { PersonData } from "./person-data.ts";
import { findIn, outsidePlaces, type Place, placesOfTable } from "./places.ts";
import { type Scope, scopesOf } from "./watched.ts";

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
 * The app `createTestApp` returned, an app given a witness, a client of either, a Durable Object
 * of a class `witnessObjects` watches, a witness, or an adapter.
 */
export type ExpectForgottenTarget =
  | { forget(personId: string, ...rest: never[]): Promise<unknown> }
  | Witness
  | Adapter;

export interface ExpectForgottenFunction {
  (
    target: ExpectForgottenTarget,
    personId: string,
    options?: ExpectForgottenOptions,
  ): Promise<void>;
}

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
    "A remembered answer holds the value outside the person's keys: the command it answered names nobody, so mark the field of its payload the value comes from personal(), or it was kept before answers were sealed and goes when its idempotency key expires.",
  snapshots:
    "A snapshot holds the value from a field left unmarked: mark it personal() where the state's value comes from.",
  subscriberFailures:
    "A subscriber's last failure quotes the value in the clear: its event names the person by no marked field holding a value, so mark the field the value comes from personal(), and keep personal data out of error messages.",
};

const opened = async (
  witness: PersonData,
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

interface ScopeSearch {
  readonly found: readonly ForgottenValueFound[];
  readonly advice: readonly string[];
  readonly needles: number;
  /**
   * The categories the person still holds a key in force of, among those asked for.
   */
  readonly stillHeld: readonly string[];
}

const searchScope = async (
  scope: Scope,
  personId: string,
  options: ExpectForgottenOptions,
): Promise<ScopeSearch> => {
  const tables = (await Promise.all(scope.adapters.map((adapter) => adapter.inspect()))).flat();
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
  // A tenant where the person still holds a key in force of a category asked for is not where
  // they were forgotten.
  if (categories !== undefined && stillHeld.length > 0) {
    return { found: [], advice: [], needles: 0, stillHeld };
  }
  const values: unknown[] = [...(options.values ?? [])];
  if (options.before !== undefined) values.push(...exportedValues(options.before, categories));
  if (scope.data !== null) {
    values.push(...(await opened(scope.data, personId, held.fingerprints, categories)));
    values.push(...scope.data.keptFor(personId, categories));
  }
  const needles = needlesOf({ values, personId });
  if (needles.length === 0) return { found: [], advice: [], needles: 0, stillHeld };
  const places: Place[] = [
    ...tables.flatMap((table) => placesOfTable(table, adviceOf)),
    ...(await outsidePlaces({
      logs: scope.logs,
      ledgers: scope.ledgers,
      traces: scope.traces,
      places: options.places,
      advice: { logs: LOGS_ADVICE, spans: SPANS_ADVICE, otherwise: OTHERWISE },
    })),
  ];
  return { ...findIn(places, needles), needles: needles.length, stillHeld };
};

/**
 * Checks that nothing a person had is left readable once they are forgotten: rejects with a
 * `NotForgottenError` that lists where each value turned up, and what to do about it, and
 * resolves when there is none.
 *
 * Given an app from `createTestApp`, an app given a witness, a client of either, a Durable Object
 * of a class `witnessObjects` watches, or the witness, it looks for every value of a field marked
 * `personal()` that the app sealed under a key the person no longer holds, and for every value a
 * read model kept in a field marked `.personal()` for them before its category was forgotten, and
 * adds `values` and `before`; with `categories`, those of the categories named alone. A key a
 * legal obligation kept past the forgetting is still held, so what it sealed is not looked for. It
 * searches each table of the storage and of every read model, read as stored and never opened,
 * the forget ledger, every entry the app logged and every span it started; for a witness that
 * watches apps of several tenants, each tenant's values in its own tables, logs and spans. Given
 * an adapter, such as one over a copy of a database, it searches that adapter's tables for
 * `values` and `before` alone.
 *
 * A value is matched without regard to case, inside any longer text, a JSON document stored as
 * text included; one shorter than `MIN_SUBSTRING_LENGTH` only as a whole word. Key material and
 * ciphertext are compared whole. A value equal to the person's id is never looked for, since ids
 * stay. Rejects with an `Error` when it has nothing to look for, so a test cannot pass for want
 * of values, and when every app it stands for has stopped. Works with any test runner.
 */
export const expectForgotten: ExpectForgottenFunction = async (target, personId, options = {}) => {
  const searched: ScopeSearch[] = [];
  for (const scope of scopesOf("expectForgotten", target)) {
    searched.push(await searchScope(scope, personId, options));
  }
  if (searched.every(({ needles }) => needles === 0)) {
    const stillHeld = [...new Set(searched.flatMap((each) => each.stillHeld))];
    if (options.categories !== undefined && stillHeld.length > 0) {
      throw new Error(
        `"${personId}" still holds a key in force of ${stillHeld.map((category) => `"${category}"`).join(", ")}: forget those categories before expectForgotten`,
      );
    }
    throw new Error(
      stillHeld.length === 0
        ? `expectForgotten found no value of "${personId}" to look for: pass the ones the test gave them as values, or their export as before`
        : `"${personId}" still holds a key: forget them before expectForgotten, which looks only for what was sealed under keys they no longer hold`,
    );
  }
  const found = searched.flatMap((each) => each.found);
  if (found.length > 0) {
    throw new NotForgottenError(personId, found, [
      ...new Set(searched.flatMap(({ advice }) => advice)),
    ]);
  }
};

/**
 * What `expectTenantForgotten` rejects with: where a value of the tenant's persons turned up, and
 * what of the tenant's keys is left.
 */
export class TenantNotForgottenError extends Error {
  readonly found: readonly ForgottenValueFound[];
  readonly problems: readonly string[];

  constructor(
    found: readonly ForgottenValueFound[],
    problems: readonly string[],
    advice: readonly string[],
  ) {
    super(
      [
        `The tenant was not forgotten everywhere: ${problems.length + found.length} ${problems.length + found.length === 1 ? "thing is" : "things are"} left.`,
        ...problems.map((problem) => `  - ${problem}`),
        ...found.map(
          ({ value, store, row, field }) => `  - "${value}" in ${store}, ${row}, ${field}`,
        ),
        ...(advice.length === 0 ? [] : ["What to do:", ...advice.map((line) => `  - ${line}`)]),
      ].join("\n"),
    );
    this.name = "TenantNotForgottenError";
    this.found = found;
    this.problems = problems;
  }
}

/**
 * What `expectTenantForgotten` searches for beyond what it finds on its own.
 */
export type ExpectTenantForgottenOptions = Pick<ExpectForgottenOptions, "values" | "places">;

export interface ExpectTenantForgottenFunction {
  (
    target:
      | { forgetTenant(tenant: string, ...rest: never[]): Promise<unknown> }
      | Witness
      | Adapter,
    options?: ExpectTenantForgottenOptions,
  ): Promise<void>;
}

// The tables a forgotten tenant's database keeps nothing in: keys, and what was sealed under them
// whole, which a copy could open while a key lived.
const EMPTIED: readonly InspectedStore[] = [
  "personalKeys",
  "indexKeys",
  "snapshots",
  "idempotencyKeys",
];

const tenantProblems = (tables: readonly InspectedTable[]): string[] => {
  const problems: string[] = [];
  for (const table of tables) {
    if (table.store !== null && EMPTIED.includes(table.store) && table.rows.length > 0) {
      problems.push(`${table.name} still holds ${table.rows.length} row(s)`);
    }
  }
  const tenancy = tables.find((table) => table.store === "tenancy")?.rows[0];
  if (tenancy === undefined) {
    problems.push("the database names no tenant: it was never bound to one");
  } else if (tenancy.forgotten_at === null || tenancy.forgotten_at === undefined) {
    problems.push(`tenant ${String(tenancy.tenant)} is not marked forgotten in its database`);
  }
  for (const table of tables.filter(({ store }) => store === "tenantKeys")) {
    for (const row of table.rows) {
      const record = JSON.parse(String(row.record)) as {
        readonly store?: unknown;
        readonly keys?: readonly unknown[];
      };
      if (tenancy !== undefined && record.store !== tenancy.store) continue;
      if ((record.keys?.length ?? 0) > 0) {
        problems.push(`the tenant key store still holds a version of ${String(row.tenant)}'s key`);
      }
    }
  }
  return problems;
};

/**
 * Checks that nothing personal of a tenant is left readable once `forgetTenant` forgot it: the
 * app refuses every call, its database holds no key, no snapshot and no remembered answer, the
 * tenant key store holds no version of its key, and no value of any of its persons turns up in the
 * clear anywhere `expectForgotten` searches. Rejects with a `TenantNotForgottenError` that lists
 * what is left, and resolves when nothing is.
 *
 * Given an app from `createTestApp`, an app given a witness, a client of either, a Durable Object
 * of a class `witnessObjects` watches, or the witness, it looks for every value of a field marked
 * `personal()` the app sealed and every value a read model kept in a field marked `.personal()`,
 * of every person, and adds `values`; for a witness that watches apps of several tenants, it
 * checks those of the tenants one of whose apps refuses calls, each in its own tables, and
 * reports that the app still serves calls when none does. Given an adapter, such as one over a
 * database restored from a copy, it checks that adapter's tables and searches them for `values`
 * alone. Works with any test runner.
 */
export const expectTenantForgotten: ExpectTenantForgottenFunction = async (
  target,
  options = {},
) => {
  const problems: string[] = [];
  const scopes = await Promise.all(
    scopesOf("expectTenantForgotten", target).map(async (scope) => ({
      scope,
      refused: await Promise.all(
        scope.running.map(({ client }) =>
          client.exportPersonalData("expect-tenant-forgotten").then(
            () => false,
            (error: unknown) => error instanceof TenantForgottenError,
          ),
        ),
      ),
    })),
  );
  const forgotten = scopes.filter(({ refused }) => refused.includes(true));
  if (scopes.some(({ refused }) => refused.length > 0) && forgotten.length === 0) {
    problems.push("the app still serves calls: forget the tenant with forgetTenant first");
  }
  if (forgotten.some(({ refused }) => refused.includes(false))) {
    problems.push(
      "an app of the tenant still serves calls: forget the tenant with forgetTenant first",
    );
  }
  // Another tenant's apps serve as they should: once one tenant's refuse, only those are checked.
  const checked = (forgotten.length === 0 ? scopes : forgotten).map(({ scope }) => scope);
  let needles = 0;
  const found: ForgottenValueFound[] = [];
  const advice = new Set<string>();
  for (const scope of checked) {
    const tables = (await Promise.all(scope.adapters.map((adapter) => adapter.inspect()))).flat();
    problems.push(...tenantProblems(tables));
    const values: unknown[] = [...(options.values ?? [])];
    const { data } = scope;
    const persons = data?.persons() ?? [];
    if (data !== null) {
      for (const person of persons) {
        values.push(...(await opened(data, person, new Set(), undefined)));
        values.push(...data.allKeptFor(person));
      }
    }
    const sought = needlesOf({ values, personId: persons });
    needles += sought.length;
    if (sought.length === 0) continue;
    const places: Place[] = [
      ...tables.flatMap((table) => placesOfTable(table, adviceOf)),
      ...(await outsidePlaces({
        logs: scope.logs,
        ledgers: scope.ledgers,
        traces: scope.traces,
        places: options.places,
        advice: { logs: LOGS_ADVICE, spans: SPANS_ADVICE, otherwise: OTHERWISE },
      })),
    ];
    const inScope = findIn(places, sought);
    found.push(...inScope.found);
    for (const line of inScope.advice) advice.add(line);
  }
  if (needles === 0 && problems.length === 0) {
    throw new Error(
      "expectTenantForgotten found no value of the tenant's persons to look for: pass the ones the test gave them as values",
    );
  }
  if (found.length > 0 || problems.length > 0) {
    throw new TenantNotForgottenError(found, problems, [...advice]);
  }
};
