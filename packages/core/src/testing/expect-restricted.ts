import type { BoundaClient } from "../kernel/app.ts";
import type { PersonalDataExport } from "../kernel/personal-data/export.ts";
import { leavesIn, matches, needlesOf } from "./search.ts";

/**
 * One value of a restricted person that something the app handed out holds.
 */
export interface RestrictedValueFound {
  readonly value: string;
  /**
   * The name of one of `places`, `dead letters` or `subscriber failures`.
   */
  readonly place: string;
  /**
   * The field, with the path into the value: `[0].email`.
   */
  readonly field: string;
}

/**
 * Thrown by `expectRestricted` when what the app handed out holds data a restriction covers.
 */
export class NotRestrictedError extends Error {
  readonly personId: string;
  readonly found: readonly RestrictedValueFound[];

  constructor(personId: string, found: readonly RestrictedValueFound[]) {
    super(
      [
        `Person "${personId}" is restricted, but ${found.length} ${found.length === 1 ? "place hands out" : "places hand out"} data the restriction covers:`,
        ...found.map(({ value, place, field }) => `  - "${value}" in ${place}, ${field}`),
        "What to do:",
        "  - Read what a query hands out through its table, or select the field marked .person() in the SQL its client runs; client.raw reads past the restriction.",
        "  - Keep personal data out of what a handler hands a port, and let restricted reactions wait for the lift, or declare the basis they run on as restricted.",
      ].join("\n"),
    );
    this.name = "NotRestrictedError";
    this.personId = personId;
    this.found = found;
  }
}

export interface ExpectRestrictedOptions {
  /**
   * What the app handed out that a restriction should have kept back, each under the name the
   * report gives it: the results of queries, what a test double of a port was sent.
   */
  readonly places?: Readonly<Record<string, unknown>>;
  /**
   * More values of the person the restriction covers, beyond those their export marks: what a
   * projection or a handler derived from their fields.
   */
  readonly values?: readonly unknown[];
}

export interface ExpectRestrictedFunction {
  (
    app: Pick<BoundaClient, "exportPersonalData" | "deadLetters" | "subscriberFailures">,
    personId: string,
    options?: ExpectRestrictedOptions,
  ): Promise<void>;
}

// The values of every field the export marks restricted.
const restrictedValues = (exported: PersonalDataExport): readonly unknown[] =>
  [
    ...exported.events,
    ...exported.scheduledCommands,
    ...exported.deadLetters,
    ...Object.values(exported.readModels).flat(),
  ].flatMap(({ data, restricted }) => restricted.map((field) => data[field]));

const pathOf = (path: readonly string[]): string =>
  path.reduce(
    (joined, step) => (step.startsWith("[") || joined === "" ? joined + step : `${joined}.${step}`),
    "",
  ) || "value";

/**
 * Checks that the person is restricted and that nothing the app handed out holds data their
 * restriction covers: the `places` the test passes, the app's dead letters and subscriber failures
 * as an operator lists them. The values looked for are those their export marks restricted,
 * whose restrictions it reads, and `values`. Rejects with `NotRestrictedError`, naming each value
 * found and where, and with an `Error` for a person with no restriction, or none of whose values
 * a restriction covers. Exporting the person is recorded in the access log, as any export.
 */
export const expectRestricted: ExpectRestrictedFunction = async (
  app,
  personId,
  { places = {}, values = [] } = {},
) => {
  const exported = await app.exportPersonalData(personId);
  const kept = Object.values(exported.categories).some(
    ({ restrictedUntil }) => restrictedUntil !== null,
  );
  if (exported.restrictions.length === 0 && !kept) {
    throw new Error(`expectRestricted found no restriction of "${personId}": restrict them first`);
  }
  const needles = needlesOf({ values: [...restrictedValues(exported), ...values], personId });
  if (needles.length === 0) {
    throw new Error(
      `expectRestricted found no value of "${personId}" their restriction covers: pass the ones the test gave them as values`,
    );
  }
  const searched: Readonly<Record<string, unknown>> = {
    ...places,
    "dead letters": await app.deadLetters.list(),
    "subscriber failures": await app.subscriberFailures.list(),
  };
  const found = Object.entries(searched).flatMap(([place, value]) =>
    leavesIn(value).flatMap((leaf) =>
      needles
        .filter((needle) => matches(needle, leaf))
        .map((needle) => ({ value: needle.value, place, field: pathOf(leaf.path) })),
    ),
  );
  if (found.length > 0) throw new NotRestrictedError(personId, found);
};
