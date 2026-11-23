import { type AdapterDefinition, isAdapterDefinition } from "../adapter/adapter-definition.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import type { ForgetLedgerSource } from "../kernel/personal-data/forget-ledger.ts";
import type { TenantKeySource } from "../kernel/personal-data/tenant-key-source.ts";

export interface CheckLocationsArgs {
  readonly storage: AdapterDefinition;
  readonly readModels: Readonly<Record<string, AdapterDefinition>>;
  readonly tenantKeys: TenantKeySource | undefined;
  readonly forgetLedger: ForgetLedgerSource | undefined;
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
// tenant's key or a record of whom the app forgot, kept anywhere else, would carry that data, or
// the means to open it, out of the jurisdiction the storage declares.
export const checkLocations: CheckLocationsFunction = ({
  storage,
  readModels,
  tenantKeys,
  forgetLedger,
}) => {
  const where = locationOf("storage", storage);
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
  ];
  for (const { path, holder, fix } of kept) {
    const location = locationOf(path, holder);
    if (where === undefined || location === where) continue;
    throw new ConfigurationError(
      `${path} ${location === undefined ? "declares no location" : `keeps its data in ${JSON.stringify(location)}`}, and storage keeps the app's in ${JSON.stringify(where)}: every store is kept where the storage is, so ${fix(where)}`,
    );
  }
};
