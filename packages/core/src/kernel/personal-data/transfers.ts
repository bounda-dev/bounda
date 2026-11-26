import type { ResolvedConfig } from "../../config/types.ts";
import type { DataLocation } from "../../modules/data-location.ts";
import { type StoreSafeguard, TRANSFER_ARTICLES } from "../../modules/recipient.ts";
import type { ExportedTransfer } from "./export.ts";

export interface StoreTransfersArgs {
  readonly config: ResolvedConfig;
  // The read models with a personal field: one without holds no personal data to transfer.
  readonly personal: (readModel: string) => boolean;
}

export interface StoreTransfersFunction {
  (args: StoreTransfersArgs): readonly ExportedTransfer[];
}

interface Placed {
  readonly location?: DataLocation | undefined;
  readonly safeguard?: StoreSafeguard | undefined;
}

const transfer = (
  store: ExportedTransfer["store"],
  readModel: string | null,
  { location, safeguard }: Placed,
): ExportedTransfer[] =>
  // `resolveConfig` lets a store declare a safeguard only beside a location out of `storage`'s.
  location === undefined || safeguard === undefined
    ? []
    : [{ store, readModel, location, safeguard, article: TRANSFER_ARTICLES[safeguard] }];

export const storeTransfers: StoreTransfersFunction = ({ config, personal }) => {
  const { keyWrapper, tenantKeys, forgetLedger } = config.runtime.personalData;
  return [
    ...Object.entries(config.readModels)
      .filter(([name]) => personal(name))
      .flatMap(([name, definition]) => transfer("read-model", name, definition)),
    ...(keyWrapper === null ? [] : transfer("master-key", null, keyWrapper)),
    ...(tenantKeys === null ? [] : transfer("tenant-keys", null, tenantKeys)),
    ...(forgetLedger === null ? [] : transfer("forget-ledger", null, forgetLedger.store)),
  ];
};
