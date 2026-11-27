import {
  ADEQUATE_COUNTRIES,
  type AdequacyScope,
  type AdequateCountry,
  COUNTRY_CODES,
  type CountryCode,
  EEA_COUNTRIES,
  type EeaCountry,
  PARTIAL_ADEQUACY,
  type PartialAdequacy,
  type PartiallyAdequateCountry,
} from "./recipient.ts";

/**
 * A place that is not one country: `"eu"` (the European Union) and `"eea"` (the European Economic
 * Area), each one legal area under the GDPR; `"fedramp"` and `"fedramp-high"`, the Durable Object
 * jurisdictions of data centres in the United States authorised under FedRAMP; and `"global"`,
 * anywhere in the world, as Workers KV keeps and caches what it holds.
 */
export type DataArea = "eu" | "eea" | "fedramp" | "fedramp-high" | "global";

/**
 * Every area, in the order of `DataArea`.
 */
export const DATA_AREAS: readonly DataArea[] = ["eu", "eea", "fedramp", "fedramp-high", "global"];

/**
 * Where a store keeps its data, as the `location` option of every adapter and store declares it: a
 * country by its ISO 3166-1 alpha-2 code in lower case, such as `"de"` or `"us"`, or one of
 * `DATA_AREAS`. The Durable Object jurisdictions `"eu"`, `"us"`, `"fedramp"` and `"fedramp-high"`
 * are all of it.
 */
export type DataLocation = Lowercase<CountryCode> | DataArea;

/**
 * The legal regime a location is under for chapter V of the GDPR: `"EEA"` for every location in
 * the European Economic Area, where data moves without a transfer; a country outside it, by its
 * ISO 3166-1 alpha-2 code; or `"anywhere"` for `"global"`, which is in no single one.
 */
export type LegalRegime = "EEA" | Exclude<CountryCode, EeaCountry> | "anywhere";

/**
 * The locations whose regime has an adequacy decision of the European Commission, or is the
 * European Economic Area itself: the only ones a store may keep its data in under the `adequacy`
 * safeguard.
 */
export type AdequateLocation =
  | Lowercase<AdequateCountry | EeaCountry>
  | Exclude<DataArea, "global">;

interface AreaRegimes {
  readonly eu: "EEA";
  readonly eea: "EEA";
  readonly fedramp: "US";
  readonly "fedramp-high": "US";
  readonly global: "anywhere";
}

const AREA_REGIMES: AreaRegimes = {
  eu: "EEA",
  eea: "EEA",
  fedramp: "US",
  "fedramp-high": "US",
  global: "anywhere",
};

// `regimeOf`, for the types.
type RegimeOf<Location extends DataLocation> = Location extends DataArea
  ? AreaRegimes[Location]
  : Uppercase<Location> extends EeaCountry
    ? "EEA"
    : Uppercase<Location>;

/**
 * The locations under the legal regime of a country of `PARTIAL_ADEQUACY`, such as `"us"` and
 * `"fedramp"`: a store kept in one rests on `adequacy` only beside its `adequacyScope`.
 */
export type PartiallyAdequateLocation = {
  [Location in DataLocation]: RegimeOf<Location> extends PartiallyAdequateCountry
    ? Location
    : never;
}[DataLocation];

/**
 * The `adequacyScope` a store kept in `Location`, one of `PartiallyAdequateLocation`, declares to
 * rest on the adequacy decision of its regime.
 */
export type AdequacyScopeOf<Location extends PartiallyAdequateLocation> = AdequacyScope<
  Extract<RegimeOf<Location>, PartiallyAdequateCountry>
>;

const COUNTRIES: ReadonlyMap<string, CountryCode> = new Map(
  COUNTRY_CODES.map((country) => [country.toLowerCase(), country]),
);
const EEA: ReadonlySet<string> = new Set(EEA_COUNTRIES);
const ADEQUATE: ReadonlySet<string> = new Set(ADEQUATE_COUNTRIES);

const isArea = (value: string): value is DataArea => Object.hasOwn(AREA_REGIMES, value);

export interface IsDataLocationFunction {
  (value: unknown): value is DataLocation;
}

/**
 * Whether a value is a `DataLocation`, as written: `"DE"` and `"EU"` are not.
 */
export const isDataLocation: IsDataLocationFunction = (value): value is DataLocation =>
  typeof value === "string" && (isArea(value) || COUNTRIES.has(value));

export interface RegimeOfFunction {
  (location: DataLocation): LegalRegime;
}

/**
 * The legal regime a location is under: two locations under the same regime, such as `"eu"` and
 * `"de"`, or `"us"` and `"fedramp"`, keep data in one; under two, keeping data in the second is a
 * transfer that a safeguard of chapter V must allow. Throws `TypeError` for a value that is not a
 * `DataLocation`.
 */
export const regimeOf: RegimeOfFunction = (location) => {
  if (isArea(location)) return AREA_REGIMES[location];
  const country = COUNTRIES.get(location);
  if (country === undefined) {
    throw new TypeError(`${JSON.stringify(location)} is not a DataLocation`);
  }
  return EEA.has(country) ? "EEA" : (country as Exclude<CountryCode, EeaCountry>);
};

export interface IsAdequateFunction {
  (regime: LegalRegime): boolean;
}

/**
 * Whether the `adequacy` safeguard can allow keeping data under a regime: the European Economic
 * Area, or a country of `ADEQUATE_COUNTRIES`; never `"anywhere"`.
 */
export const isAdequate: IsAdequateFunction = (regime) => regime === "EEA" || ADEQUATE.has(regime);

export interface PartialAdequacyOfFunction {
  (regime: LegalRegime): PartialAdequacy | null;
}

const PARTIAL: ReadonlyMap<string, PartialAdequacy> = new Map(Object.entries(PARTIAL_ADEQUACY));

/**
 * The adequacy decision of `PARTIAL_ADEQUACY` that covers some recipients alone under a regime,
 * whose `condition` a transfer resting on `adequacy` there must meet; `null` under any other
 * regime, adequate as a whole or not.
 */
export const partialAdequacyOf: PartialAdequacyOfFunction = (regime) => PARTIAL.get(regime) ?? null;
