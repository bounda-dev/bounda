import type { Logger } from "../../contracts/logger.ts";
import type { Adapter } from "../adapter.ts";

/**
 * A key of a tenant's database file: its id, which names it without giving it away, and the text
 * the engine opens the file with.
 */
export interface FileKey {
  readonly id: string;
  readonly key: string;
}

/**
 * The keys a tenant's database file is encrypted under, as the tenant key store keeps them, for
 * the adapter that opens it. Each key comes out as the text the engine opens the file with: the
 * adapter hands it to the engine at once and keeps it nowhere.
 */
export interface FileKeyAccess {
  /**
   * The tenant the keys are of: a file bound to another is refused before anything is written to
   * it.
   */
  readonly tenant: string;
  /**
   * The key the file is to be encrypted under. `null` once the tenant is forgotten and its
   * recipients told: nothing opens the file, or any copy of it, again.
   */
  current(): Promise<FileKey | null>;
  /**
   * The other keys the file may be encrypted under: its earlier ones, newest first, then those of
   * the tenant's other files, as a copy restored under another name is.
   */
  previous(): Promise<readonly FileKey[]>;
  /**
   * Records that the file is encrypted under the key of that id, the one in force when read:
   * retiring the tenant key's older versions then destroys its earlier ones too. A key put in
   * force since is left unconfirmed, so the earlier ones stay until the file moves under it.
   */
  confirm(id: string): Promise<void>;
}

export interface OpenEncryptedFileArgs {
  readonly keys: FileKeyAccess;
  /**
   * Told when the file stays under its earlier key, or in the clear, for now.
   */
  readonly logger: Logger;
}

/**
 * A database file the adapter encrypts under a key the tenant key store keeps for its tenant. An
 * app with a key wrapper and a tenant key store opens it through `open`, never directly.
 */
export interface EncryptedFile {
  /**
   * The name the tenant's record keeps the file's keys under: the same for every adapter over the
   * file, wherever the app runs.
   */
  readonly database: string;
  /**
   * The adapter over the file opened under the key in force: a file in the clear, or under
   * another key of the tenant's, is encrypted under it first, and that confirmed, once no other
   * connection has it open; until then it opens as it is, and `logger` is told. Without a key in
   * force, the adapter is over a database in memory: the file no longer opens.
   */
  open(args: OpenEncryptedFileArgs): Promise<Adapter>;
}

/**
 * Where a file opened under the tenant's keys stands: `"current"` once encrypted under the key in
 * force, `"earlier"` while still under an earlier key of the tenant's, `"clear"` while not
 * encrypted at all, as a file stays while another connection has it open when the app starts.
 */
export type FileEncryptionState = "current" | "earlier" | "clear";

/**
 * The encryption of the file an adapter `EncryptedFile.open` returned is over.
 */
export interface FileEncryption {
  /**
   * The file, as `EncryptedFile.database` names it.
   */
  readonly database: string;
  state(): FileEncryptionState;
  /**
   * Reads the key in force again, as a rotation of the tenant's key changes it, and resolves to
   * where the file stands against it.
   */
  refresh(): Promise<FileEncryptionState>;
  /**
   * Encrypts the file under the key in force through the adapter's own connection, once no other
   * has it open, and resolves to where it stands after.
   */
  settle(): Promise<FileEncryptionState>;
}
