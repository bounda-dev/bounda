import { type AdapterDefinition, isAdapterDefinition } from "../adapter/adapter-definition.ts";
import { checkPlacement, checkStorageLocation } from "../adapter/placement.ts";
import type { ForgetLedgerSource } from "../kernel/personal-data/forget-ledger.ts";
import type { KeyWrapperDefinition } from "../kernel/personal-data/key-wrapper.ts";
import type { TenantKeySource } from "../kernel/personal-data/tenant-key-source.ts";
import type { DataLocation } from "../modules/data-location.ts";

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

interface Kept {
  readonly path: string;
  readonly holder: object;
  readonly fix: (location: DataLocation) => string;
}

const adapterFix =
  (name: string) =>
  (location: DataLocation): string =>
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
  const where = checkStorageLocation(storage);
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
            fix: (location: DataLocation) =>
              `declare it through masterKey({ from, location: ${JSON.stringify(location)} }) or defineKeyWrapper(create, { location: ${JSON.stringify(location)} })`,
          },
        ]),
  ];
  for (const { path, holder, fix } of kept) checkPlacement({ path, holder, where, fix });
};
