/**
 * One version of a tenant's key as the tenant key store keeps it: its id, which the keys it wraps
 * name, its check value, the key wrapped under the master key `wrappedBy` names, in base64, and
 * when it was created.
 */
export interface StoredTenantKey {
  readonly kid: string;
  readonly fingerprint: string;
  readonly key: string;
  readonly wrappedBy: string;
  readonly createdAt: string;
}

/**
 * The key a database file of the tenant is encrypted under, for an engine that encrypts it, such
 * as libSQL: which database, its id, the key wrapped under the version of the tenant's key, or the
 * master key, `wrappedBy` names, in base64, when it was created, and when the file was first found
 * encrypted under it.
 */
export interface StoredFileKey {
  readonly database: string;
  readonly id: string;
  readonly key: string;
  readonly wrappedBy: string;
  readonly createdAt: string;
  /**
   * Absent until the file opens under it: retiring the tenant key's older versions keeps the
   * file's earlier keys until then.
   */
  readonly appliedAt?: string;
}

/**
 * The forgetting of a tenant: when, and the id of the `TenantForgotten` event that records it, so
 * a database that lacks it, restored from a copy, is given the same one. `files` keeps the keys of
 * its encrypted database files, under the master key, only until its recipients are told.
 */
export interface TenantForgetting {
  readonly at: string;
  readonly eventId: string;
  readonly files?: readonly StoredFileKey[];
}

/**
 * A declaration of the app's recipients that a start could not write to the tenant's database,
 * frozen then: each `from` renamed to its `to`, in order, then `ports` declared with what the
 * stream held through `position` presumed theirs, as of `at`. `id` names it once written, so it is
 * written once.
 */
export interface PendingRecipientDeclaration {
  readonly id: string;
  readonly renames: readonly { readonly from: string; readonly to: string }[];
  readonly ports: readonly { readonly port: string; readonly categories: readonly string[] }[];
  readonly position: number;
  readonly at: string;
}

/**
 * Everything the tenant key store keeps of one tenant: the database its keys belong to, by the
 * random id that database was given, the versions of its key, the one in force first, and, once
 * it is forgotten, the forgetting, with no version left.
 */
export interface TenantKeyRecord {
  readonly store: string;
  readonly keys: readonly StoredTenantKey[];
  readonly forgotten: TenantForgetting | null;
  /**
   * The keys of its encrypted database files, the one in force of each database first.
   */
  readonly files?: readonly StoredFileKey[];
  /**
   * When `freezeTenant` froze the tenant, as an ISO timestamp, absent while it is not frozen: no
   * version is put in force or retired, and no file is given a key, until `unfreezeTenant`.
   */
  readonly frozenAt?: string;
  /**
   * The declarations of the app's recipients that starts on the frozen tenant could not write to
   * its database, oldest first: every instance reads the tenant's recipients as if they were
   * written, until the thaw, or the tenant's forgetting, writes them and removes them. Absent when
   * there is none.
   */
  readonly pendingRecipients?: readonly PendingRecipientDeclaration[];
}

export interface VersionedTenantKeyRecord extends TenantKeyRecord {
  /**
   * Raised by one at every write, from 1 for the first.
   */
  readonly revision: number;
}

/**
 * Where the keys of tenants live, outside every tenant's database, so neither a copy of one nor a
 * restore brings back a tenant key once its tenant is forgotten: a table in another database, a
 * KV namespace, or a store of your own. Keeps one record per tenant.
 *
 * `put` writes `record` as the next revision only while the tenant's record is still at
 * `expected`, `null` for none, and reports whether it did: of two writers, one wins and the other
 * reads again. A store that cannot compare and set, such as KV, must be written by one writer per
 * tenant, as a Durable Object is.
 */
export interface TenantKeyStore {
  get(tenant: string): Promise<VersionedTenantKeyRecord | null>;
  put(tenant: string, record: TenantKeyRecord, expected: number | null): Promise<boolean>;
  /**
   * A page of the tenants it holds a record of, from `cursor` (`null` for the first page), about
   * `limit` of them: what a rotation of the master key goes through.
   */
  list(args: ListTenantKeysArgs): Promise<TenantKeysPage>;
  /**
   * `true` for a store each tenant's record of which one writer alone may write, as KV is, since
   * it cannot compare and set: nothing but that writer rewraps a record there.
   */
  readonly oneWriterPerTenant?: boolean;
  close?(): Promise<void>;
}

export interface ListTenantKeysArgs {
  readonly cursor: string | null;
  readonly limit: number;
}

export interface TenantKeysPage {
  readonly tenants: readonly string[];
  /**
   * Where the next page starts, `null` after the last.
   */
  readonly cursor: string | null;
}
