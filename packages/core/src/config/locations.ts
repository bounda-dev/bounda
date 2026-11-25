import { type AdapterDefinition, isAdapterDefinition } from "../adapter/adapter-definition.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import type { ForgetLedgerSource } from "../kernel/personal-data/forget-ledger.ts";
import type { KeyWrapperDefinition } from "../kernel/personal-data/key-wrapper.ts";
import type { TenantKeySource } from "../kernel/personal-data/tenant-key-source.ts";
import { STORE_SAFEGUARDS, type StoreSafeguard, TRANSFER_ARTICLES } from "../modules/recipient.ts";

export interface CheckLocationsArgs {
  readonly storage: AdapterDefinition;
  readonly readModels: Readonly<Record<string, AdapterDefinition>>;
  readonly tenantKeys: TenantKeySource | undefined;
  readonly forgetLedger: ForgetLedgerSource | undefined;
  readonly keyWrapper: KeyWrapperDefinition | undefined;
}

export interface CheckLocationsFunction {
  (args: CheckLocationsArgs): void;
}

// A configuration is not always type-checked: a location is read as whatever it holds.
const locationOf = (path: string, holder: object): string | undefined => {
  const location: unknown = Reflect.get(holder, "location");
  if (location === undefined) return undefined;
  if (typeof location !== "string" || location.trim() === "") {
    throw new ConfigurationError(
      `${path} declares where it keeps its data with a jurisdiction such as "eu", not ${JSON.stringify(location)}`,
    );
  }
  return location;
};

const SAFEGUARDS = STORE_SAFEGUARDS.map(
  (safeguard) => `"${safeguard}" (article ${TRANSFER_ARTICLES[safeguard]})`,
).join(", ");

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

interface Kept {
  readonly path: string;
  readonly holder: object;
  readonly fix: (location: string) => string;
}

const adapterFix =
  (name: string) =>
  (location: string): string =>
    `give its ${name}() location: ${JSON.stringify(location)}`;

const definitionFix = (holder: object, define: string): Kept["fix"] =>
  isAdapterDefinition(holder)
    ? adapterFix(holder.name)
    : (location) =>
        `declare it through ${define}(create, { location: ${JSON.stringify(location)} })`;

// The storage holds the events, the source of every copy of a person's data: a read model, the
// tenant's key, the master key that opens it or a record of whom the app forgot, kept anywhere
// else, would carry that data, or the means to open it, out of the jurisdiction the storage
// declares (keys abroad defeat the encryption that protects data at home, EDPB 01/2020), unless a
// safeguard of chapter V allows the transfer.
export const checkLocations: CheckLocationsFunction = ({
  storage,
  readModels,
  tenantKeys,
  forgetLedger,
  keyWrapper,
}) => {
  const where = locationOf("storage", storage);
  if (Reflect.get(storage, "safeguard") !== undefined) {
    throw new ConfigurationError(
      "storage declares a safeguard, and storage is where the app keeps its data, not a transfer out of it: a safeguard belongs to a store kept in another location than storage's",
    );
  }
  const kept: Kept[] = [
    ...Object.entries(readModels).map(([name, definition]) => ({
      path: `readModels.${name}`,
      holder: definition,
      fix: adapterFix(definition.name),
    })),
    ...(tenantKeys === undefined
      ? []
      : [
          {
            path: "runtime.personalData.tenantKeys",
            holder: tenantKeys,
            fix: definitionFix(tenantKeys, "defineTenantKeyStore"),
          },
        ]),
    ...(forgetLedger === undefined
      ? []
      : [
          {
            path: "runtime.personalData.forgetLedger.store",
            holder: forgetLedger,
            fix: definitionFix(forgetLedger, "defineForgetLedger"),
          },
        ]),
    ...(keyWrapper === undefined
      ? []
      : [
          {
            path: "runtime.personalData.keyWrapper",
            holder: keyWrapper,
            fix: (location: string) =>
              `declare it through masterKey({ from, location: ${JSON.stringify(location)} }) or defineKeyWrapper(create, { location: ${JSON.stringify(location)} })`,
          },
        ]),
  ];
  for (const { path, holder, fix } of kept) {
    const location = locationOf(path, holder);
    const safeguard = safeguardOf(path, holder);
    if (safeguard !== undefined && location === undefined) {
      throw new ConfigurationError(
        `${path} declares a safeguard and no location: a safeguard allows keeping data in a location, so declare where it keeps its data beside it`,
      );
    }
    if (where === undefined) {
      if (safeguard === undefined) continue;
      throw new ConfigurationError(
        `${path} keeps its data in ${JSON.stringify(location)} under a safeguard, and storage declares no location, so nothing tells whether that is a transfer: declare where storage keeps the app's data`,
      );
    }
    if (location === undefined) {
      throw new ConfigurationError(
        `${path} declares no location, and storage keeps the app's in ${JSON.stringify(where)}: every store is kept where the storage is, or elsewhere under a safeguard, so ${fix(where)}`,
      );
    }
    if (location === where) {
      if (safeguard === undefined) continue;
      throw new ConfigurationError(
        `${path} keeps its data in ${JSON.stringify(where)}, where storage keeps the app's, under a safeguard, and keeping it there is no transfer: remove its safeguard`,
      );
    }
    if (safeguard !== undefined) continue;
    throw new ConfigurationError(
      `${path} keeps its data in ${JSON.stringify(location)}, and storage keeps the app's in ${JSON.stringify(where)}: keeping it there is a transfer, which a safeguard must allow, so declare its safeguard beside its location, one of ${SAFEGUARDS}, or keep it where the storage is and ${fix(where)}`,
    );
  }
};
