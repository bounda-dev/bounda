/**
 * Whose database this is: the tenant it serves, the random id it was given, which the tenant key
 * store records next to the tenant's key, since when, and when its tenant was forgotten, `null`
 * while it is not.
 */
export interface Tenancy {
  readonly tenant: string;
  readonly store: string;
  readonly boundAt: string;
  readonly forgottenAt: string | null;
}

/**
 * The one row that binds a database to its tenant. `bind` writes it unless the database holds one
 * already, and resolves the one it holds: of two instances binding at once, both end with the
 * same. `forget` records that the tenant was forgotten, keeping the first time it was.
 */
export interface TenancyStore {
  get(): Promise<Tenancy | null>;
  bind(tenancy: Omit<Tenancy, "forgottenAt">): Promise<Tenancy>;
  forget(at: string): Promise<void>;
}
