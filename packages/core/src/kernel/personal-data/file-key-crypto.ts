import { fromBase64, TENANT_KEY_ALGORITHM, toBase64 } from "./crypto.ts";

// A file key only ever leaves WebCrypto as the text the engine opens the file with.
const FILE_KEY_ALGORITHM = { name: "AES-GCM", length: 256 } as const;

export interface WrapFileKeyFunction {
  (args: { readonly key: CryptoKey; readonly under: CryptoKey }): Promise<string>;
}

// A file key, exportable, wrapped under a version of the tenant's key.
export const wrapFileKey: WrapFileKeyFunction = async ({ key, under }) =>
  toBase64(new Uint8Array(await crypto.subtle.wrapKey("raw", key, under, TENANT_KEY_ALGORITHM)));

export interface UnwrapFileKeyFunction {
  (args: { readonly wrapped: string; readonly under: CryptoKey }): Promise<CryptoKey>;
}

// Exportable only to be wrapped again or opened as the engine's text, never kept.
export const unwrapFileKey: UnwrapFileKeyFunction = ({ wrapped, under }) =>
  crypto.subtle.unwrapKey(
    "raw",
    fromBase64(wrapped),
    under,
    TENANT_KEY_ALGORITHM,
    FILE_KEY_ALGORITHM,
    true,
    ["encrypt"],
  );

export interface NewFileKeyFunction {
  (): Promise<CryptoKey>;
}

export const newFileKey: NewFileKeyFunction = () =>
  crypto.subtle.generateKey(FILE_KEY_ALGORITHM, true, ["encrypt"]);
