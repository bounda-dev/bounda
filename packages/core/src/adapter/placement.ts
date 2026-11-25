import { ConfigurationError } from "../contracts/errors.ts";
import {
  DATA_AREAS,
  type DataLocation,
  isAdequate,
  isDataLocation,
  type LegalRegime,
  regimeOf,
} from "../modules/data-location.ts";
import { STORE_SAFEGUARDS, type StoreSafeguard, TRANSFER_ARTICLES } from "../modules/recipient.ts";

const AREAS = DATA_AREAS.map((area) => JSON.stringify(area)).join(", ");

// A configuration is not always type-checked: a location is read as whatever it holds, and one
// Bounda does not know is refused rather than guessed at, since a wrong guess would hide a transfer.
const locationOf = (path: string, holder: object): DataLocation | undefined => {
  const location: unknown = Reflect.get(holder, "location");
  if (location === undefined || isDataLocation(location)) return location;
  const written =
    typeof location === "string" && isDataLocation(location.toLowerCase())
      ? `: write it ${JSON.stringify(location.toLowerCase())}`
      : "";
  throw new ConfigurationError(
    `${path} declares where it keeps its data as ${JSON.stringify(location)}, which is no location Bounda knows${written}: a country by its ISO 3166-1 alpha-2 code in lower case, such as "de", or one of ${AREAS}`,
  );
};

const listed = (safeguards: readonly StoreSafeguard[]): string =>
  safeguards
    .map((safeguard) => `"${safeguard}" (article ${TRANSFER_ARTICLES[safeguard]})`)
    .join(", ");

const SAFEGUARDS = listed(STORE_SAFEGUARDS);
const BUT_ADEQUACY = listed(STORE_SAFEGUARDS.filter((safeguard) => safeguard !== "adequacy"));

const isStoreSafeguard = (value: unknown): value is StoreSafeguard =>
  STORE_SAFEGUARDS.some((safeguard) => safeguard === value);

const safeguardOf = (path: string, holder: object): StoreSafeguard | undefined => {
  const safeguard: unknown = Reflect.get(holder, "safeguard");
  if (safeguard === undefined || isStoreSafeguard(safeguard)) return safeguard;
  throw new ConfigurationError(
    safeguard === "derogation"
      ? `${path} rests keeping its data abroad on a derogation, which article 49 allows for occasional transfers alone, never for data kept there as long as the app runs: declare one of ${SAFEGUARDS}`
      : `${path} declares the safeguard ${JSON.stringify(safeguard)}, which is none of ${SAFEGUARDS}`,
  );
};

const regimeText = (regime: LegalRegime): string =>
  regime === "EEA"
    ? "in the European Economic Area"
    : regime === "anywhere"
      ? "anywhere in the world"
      : `in the country ${regime}`;

export interface CheckPlacementArgs {
  /**
   * What the store is, as the refusal names it, such as `"readModels.orders"`.
   */
  readonly path: string;
  /**
   * The store's definition, whose `location` and `safeguard` are judged.
   */
  readonly holder: object;
  /**
   * Where `storage` keeps the app's data, `undefined` when it declares nowhere.
   */
  readonly where: DataLocation | undefined;
  /**
   * How to keep the store where `storage` is, for the refusal: `give its sqlite() location: "eu"`.
   */
  readonly fix: (where: DataLocation) => string;
}

export interface CheckPlacementFunction {
  (args: CheckPlacementArgs): void;
}

/**
 * Refuses, with `ConfigurationError`, a store kept where the app may not keep it, as every runtime
 * does at boot for each read model's adapter, the tenant key store, the forget ledger and the key
 * wrapper: a location or a safeguard Bounda does not know, a safeguard without a location or under
 * a `storage` that declares none, a store that declares no location under one that does, a store
 * under another legal regime than `storage`'s (`regimeOf`) without a safeguard, a safeguard where
 * keeping the data is no transfer, an `adequacy` for a regime with no adequacy decision, and a
 * `storage` in `"global"`, which is in no jurisdiction to keep the app's data in.
 */
export const checkPlacement: CheckPlacementFunction = ({ path, holder, where, fix }) => {
  const location = locationOf(path, holder);
  const safeguard = safeguardOf(path, holder);
  if (safeguard !== undefined && location === undefined) {
    throw new ConfigurationError(
      `${path} declares a safeguard and no location: a safeguard allows keeping data in a location, so declare where it keeps its data beside it`,
    );
  }
  if (where === undefined) {
    if (safeguard === undefined) return;
    throw new ConfigurationError(
      `${path} keeps its data in ${JSON.stringify(location)} under a safeguard, and storage declares no location, so nothing tells whether that is a transfer: declare where storage keeps the app's data`,
    );
  }
  const home = regimeOf(where);
  if (home === "anywhere") throw globalStorage();
  if (location === undefined) {
    throw new ConfigurationError(
      `${path} declares no location, and storage keeps the app's in ${JSON.stringify(where)}: every store is kept where the storage is, or elsewhere under a safeguard, so ${fix(where)}`,
    );
  }
  const regime = regimeOf(location);
  if (regime === home) {
    if (safeguard === undefined) return;
    throw new ConfigurationError(
      `${path} keeps its data in ${JSON.stringify(location)} under a safeguard, and storage keeps the app's in ${JSON.stringify(where)}, both ${regimeText(home)}, so keeping it there is no transfer: remove its safeguard`,
    );
  }
  if (safeguard === undefined) {
    throw new ConfigurationError(
      `${path} keeps its data in ${JSON.stringify(location)}, ${regimeText(regime)}, and storage keeps the app's in ${JSON.stringify(where)}, ${regimeText(home)}: keeping it there is a transfer, which a safeguard must allow, so declare its safeguard beside its location, one of ${SAFEGUARDS}, or keep it where the storage is and ${fix(where)}`,
    );
  }
  if (safeguard === "adequacy" && !isAdequate(regime)) {
    throw new ConfigurationError(
      `${path} keeps its data in ${JSON.stringify(location)} under the safeguard "adequacy", and no adequacy decision of the European Commission covers data kept ${regimeText(regime)}: declare one of ${BUT_ADEQUACY}`,
    );
  }
};

const globalStorage = (): ConfigurationError =>
  new ConfigurationError(
    'storage declares the location "global", and storage is where the app keeps its data, which "global" places in no jurisdiction: declare where it keeps it, or no location',
  );

export interface CheckStorageLocationFunction {
  (storage: object): DataLocation | undefined;
}

// The storage's location is the app's: every other store is judged against it.
export const checkStorageLocation: CheckStorageLocationFunction = (storage) => {
  const where = locationOf("storage", storage);
  if (where === "global") throw globalStorage();
  if (Reflect.get(storage, "safeguard") !== undefined) {
    throw new ConfigurationError(
      "storage declares a safeguard, and storage is where the app keeps its data, not a transfer out of it: a safeguard belongs to a store kept in another location than storage's",
    );
  }
  return where;
};
