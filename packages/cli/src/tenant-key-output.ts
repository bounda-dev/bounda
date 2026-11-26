import {
  errorFields,
  type FailedTenantKey,
  type RefusedStaleTenantKey,
  type StaleTenantKey,
  type TenantKeysInspection,
  type UnreachedTenant,
} from "@bounda-dev/core";
import type { ErrorText } from "@bounda-dev/core/config";

export interface TenantKeyLines {
  readonly out: readonly string[];
  readonly err: readonly string[];
}

const messageOf = (error: unknown, errorText: ErrorText): string => {
  const { errorName, errorMessage } = errorFields({ error, errorText });
  return errorMessage ?? errorName;
};

const storeOf = (namedBy: string): string =>
  `the tenant key store ${namedBy}'s configuration names`;

const lostOf = ({ versions, files }: StaleTenantKey["lost"]): string =>
  [
    ...(versions.length === 0 ? [] : [`versions ${versions.join(", ")}`]),
    ...(files.length === 0 ? [] : [`file keys ${files.join(", ")}`]),
  ].join(" and ");

export interface FormatStaleFunction {
  (stale: StaleTenantKey): string;
}

export const formatStale: FormatStaleFunction = ({ tenant, namedBy, named, lost }) => {
  const copy = `${tenant}: a copy of its key in ${storeOf(namedBy)}`;
  const remove = `remove it with bounda tenant-key remove-stale ${tenant}`;
  switch (named) {
    case "forgotten":
      return `${copy}, though it is forgotten: ${remove}`;
    case "holds":
      return `${copy}; the store its own configuration names holds the same key: ${remove}`;
    case "differs":
      return `${copy}, holding ${lostOf(lost)}, which the store its own configuration names lacks`;
    case "lacks":
      return `${copy}, the only one: the store its own configuration names holds no record of it`;
  }
};

const unreachedLines = (unreached: readonly UnreachedTenant[], errorText: ErrorText) =>
  unreached.map(
    ({ tenant, error }) =>
      `error: the stores ${tenant}'s configuration names could not be listed: ${messageOf(error, errorText)}`,
  );

const failedLines = (failed: readonly FailedTenantKey[], errorText: ErrorText) =>
  failed.map(
    ({ tenant, error }) =>
      `error: ${tenant}'s key could not be read: ${messageOf(error, errorText)}`,
  );

const refusedLines = (refused: readonly RefusedStaleTenantKey[], errorText: ErrorText) =>
  refused.map(
    ({ tenant, namedBy, error }) =>
      `error: ${tenant}'s copy in ${storeOf(namedBy)} was not removed: ${messageOf(error, errorText)}`,
  );

export interface FormatTenantKeysStatusFunction {
  (inspection: TenantKeysInspection, errorText: ErrorText): TenantKeyLines;
}

export const formatTenantKeysStatus: FormatTenantKeysStatusFunction = (
  { stores, underPreviousMaster, stale, failed, unreached },
  errorText,
) => {
  const unread = new Set([...failed, ...unreached].map(({ tenant }) => tenant)).size;
  return {
    out: [
      `${stores} tenant key store(s) read`,
      underPreviousMaster.length === 0
        ? "no tenant's key read is under a previous master key"
        : `${underPreviousMaster.length} tenant(s) with a key under a previous master key: ${underPreviousMaster.join(", ")}; rewrap them with bounda tenant-key rewrap-master`,
      ...stale.map(formatStale),
    ],
    err: [
      ...unreachedLines(unreached, errorText),
      ...failedLines(failed, errorText),
      ...(unread === 0
        ? []
        : [
            `${unread} tenant(s) not read: what their stores hold is unknown, so keep the previous master keys`,
          ]),
    ],
  };
};

export interface KeyCopiesLeft {
  readonly refused: readonly RefusedStaleTenantKey[];
  readonly unreached: readonly UnreachedTenant[];
}

export interface FormatKeyCopiesLeftFunction {
  (left: KeyCopiesLeft, errorText: ErrorText): readonly string[];
}

export const formatKeyCopiesLeft: FormatKeyCopiesLeftFunction = (
  { refused, unreached },
  errorText,
) => [...unreachedLines(unreached, errorText), ...refusedLines(refused, errorText)];

export interface FormatRemovedCopyFunction {
  (copy: Pick<StaleTenantKey, "tenant" | "namedBy">): string;
}

export const formatRemovedCopy: FormatRemovedCopyFunction = ({ tenant, namedBy }) =>
  `removed ${tenant}'s copy in ${storeOf(namedBy)}`;
