import { DurableObject } from "cloudflare:workers";
import { ConfigurationError } from "@bounda-dev/core";
import type {
  ForgetLedger,
  ForgetLedgerEntry,
  ListTenantKeysArgs,
  PruneForgetLedgerArgs,
  ReadForgetLedgerArgs,
  TenantKeyRecord,
  TenantKeyStore,
  TenantKeysPage,
  VersionedTenantKeyRecord,
} from "@bounda-dev/core/adapter";
import { DEFAULT_TABLE_PREFIX, quoteIdentifier } from "@bounda-dev/core/adapter/sql";
import type { Config } from "@bounda-dev/core/config";
import { durableObjectAdapter } from "./adapter.ts";
import { cloudflareStorageOf } from "./definition.ts";
import { checkObjectJurisdiction } from "./jurisdiction.ts";
import { type RpcOutcome, settle } from "./outcome.ts";

// The name of the keeper that lists the tenants; every other keeper is one tenant's, named by
// `keeperNameOf`, which never gives this one.
export const KEEPER_DIRECTORY = "directory";
const TENANT_KEEPER = "tenant:";

export interface KeeperNameOfFunction {
  (tenant: string): string;
}

export const keeperNameOf: KeeperNameOfFunction = (tenant) => `${TENANT_KEEPER}${tenant}`;

const DIRECTORY_TABLE = quoteIdentifier(`${DEFAULT_TABLE_PREFIX}keeper_tenants`);

/**
 * What a keeper object answers over RPC, each method an outcome as a Bounda object's are. A
 * tenant's keeper holds that tenant's key record and forget ledger and refuses calls for any other
 * tenant; the directory lists the tenants that have a record. Reached through
 * `durableObjectTenantKeys` and `durableObjectForgetLedger` alone.
 */
export interface BoundaKeeperMethods {
  getTenantKeys(tenant: string): Promise<RpcOutcome<VersionedTenantKeyRecord | null>>;
  putTenantKeys(
    tenant: string,
    record: TenantKeyRecord,
    expected: number | null,
  ): Promise<RpcOutcome<boolean>>;
  registerTenant(tenant: string): Promise<RpcOutcome<null>>;
  listTenants(args: ListTenantKeysArgs): Promise<RpcOutcome<TenantKeysPage>>;
  appendLedger(tenant: string, entries: readonly ForgetLedgerEntry[]): Promise<RpcOutcome<null>>;
  readLedger(
    tenant: string,
    args: ReadForgetLedgerArgs,
  ): Promise<RpcOutcome<readonly ForgetLedgerEntry[]>>;
  pruneLedger(tenant: string, args: PruneForgetLedgerArgs): Promise<RpcOutcome<null>>;
  readLedgerMark(tenant: string, name: string): Promise<RpcOutcome<number>>;
  raiseLedgerMark(tenant: string, name: string, value: number): Promise<RpcOutcome<null>>;
}

/**
 * The class `createBoundaKeeper` returns, to export from the Worker and bind in `wrangler.jsonc`.
 */
export interface BoundaKeeperClass {
  new (ctx: DurableObjectState, env: Cloudflare.Env): DurableObject & BoundaKeeperMethods;
}

export interface CreateBoundaKeeperArgs {
  /**
   * The app's configuration, with `storage: cloudflare()`, whose `jurisdiction` the keeper holds
   * to as every tenant's object does.
   */
  readonly config: Config;
}

export interface CreateBoundaKeeperFunction {
  (args: CreateBoundaKeeperArgs): BoundaKeeperClass;
}

/**
 * Builds the Durable Object class that keeps, outside every tenant's object, what must outlive
 * the tenant's storage: each tenant's key, wrapped under the master key, and its forget ledger,
 * one keeper object per tenant, plus one that lists the tenants for a rotation of the master key.
 * In the jurisdiction `cloudflare()` names, like the tenants' objects, so nothing tied to a person
 * leaves it; restoring a tenant's object to an earlier time leaves its keeper as it is. Use it
 * through `durableObjectTenantKeys` and `durableObjectForgetLedger`. A keeper created in another
 * jurisdiction than `cloudflare()` names, or reached by a name the stores never give, refuses
 * every call with `ConfigurationError`.
 */
export const createBoundaKeeper: CreateBoundaKeeperFunction = ({ config }) => {
  const { binding, jurisdiction } = cloudflareStorageOf(config).options;
  return class BoundaKeeper extends DurableObject implements BoundaKeeperMethods {
    #keys: Promise<TenantKeyStore> | undefined;
    #ledger: Promise<ForgetLedger> | undefined;

    #checked(): void {
      checkObjectJurisdiction({
        id: this.ctx.id,
        jurisdiction,
        namespace: Reflect.get(this.env as object, binding) as DurableObjectNamespace | undefined,
        kind: "keeper",
      });
    }

    // Only the keeper of `tenant` answers for it: a record or an entry kept anywhere else would
    // be one no reader finds.
    #of(tenant: string): void {
      this.#checked();
      if (this.ctx.id.name !== keeperNameOf(tenant)) {
        throw new ConfigurationError(
          `This keeper Durable Object keeps ${this.ctx.id.name === undefined ? "no tenant" : `"${this.ctx.id.name}"`}, not tenant ${tenant}: reach it through durableObjectTenantKeys() and durableObjectForgetLedger() alone`,
        );
      }
    }

    #directoryTable(): void {
      this.#checked();
      if (this.ctx.id.name !== KEEPER_DIRECTORY) {
        throw new ConfigurationError(
          "Only the keeper named directory lists the tenants: reach it through durableObjectTenantKeys() alone",
        );
      }
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS ${DIRECTORY_TABLE} ("tenant" TEXT NOT NULL PRIMARY KEY)`,
      );
    }

    #adapter() {
      return durableObjectAdapter({ storage: this.ctx.storage });
    }

    #tenantKeys(tenant: string): Promise<TenantKeyStore> {
      this.#of(tenant);
      this.#keys ??= this.#adapter().createTenantKeyStore();
      return this.#keys;
    }

    #forgetLedger(tenant: string): Promise<ForgetLedger> {
      this.#of(tenant);
      this.#ledger ??= this.#adapter().createForgetLedger({ tenant });
      return this.#ledger;
    }

    getTenantKeys(tenant: string): Promise<RpcOutcome<VersionedTenantKeyRecord | null>> {
      return settle(async () => (await this.#tenantKeys(tenant)).get(tenant));
    }

    putTenantKeys(
      tenant: string,
      record: TenantKeyRecord,
      expected: number | null,
    ): Promise<RpcOutcome<boolean>> {
      return settle(async () => (await this.#tenantKeys(tenant)).put(tenant, record, expected));
    }

    registerTenant(tenant: string): Promise<RpcOutcome<null>> {
      return settle(async () => {
        this.#directoryTable();
        this.ctx.storage.sql.exec(
          `INSERT INTO ${DIRECTORY_TABLE} ("tenant") VALUES (?) ON CONFLICT ("tenant") DO NOTHING`,
          tenant,
        );
        return null;
      });
    }

    listTenants({ cursor, limit }: ListTenantKeysArgs): Promise<RpcOutcome<TenantKeysPage>> {
      return settle(async () => {
        this.#directoryTable();
        const rows = (
          cursor === null
            ? this.ctx.storage.sql.exec<{ tenant: string }>(
                `SELECT "tenant" FROM ${DIRECTORY_TABLE} ORDER BY "tenant" LIMIT ?`,
                limit,
              )
            : this.ctx.storage.sql.exec<{ tenant: string }>(
                `SELECT "tenant" FROM ${DIRECTORY_TABLE} WHERE "tenant" > ? ORDER BY "tenant" LIMIT ?`,
                cursor,
                limit,
              )
        ).toArray();
        const tenants = rows.map(({ tenant }) => tenant);
        return { tenants, cursor: tenants.length < limit ? null : (tenants.at(-1) ?? null) };
      });
    }

    appendLedger(tenant: string, entries: readonly ForgetLedgerEntry[]): Promise<RpcOutcome<null>> {
      return settle(async () => {
        await (await this.#forgetLedger(tenant)).append(entries);
        return null;
      });
    }

    readLedger(
      tenant: string,
      args: ReadForgetLedgerArgs,
    ): Promise<RpcOutcome<readonly ForgetLedgerEntry[]>> {
      return settle(async () => (await this.#forgetLedger(tenant)).read(args));
    }

    pruneLedger(tenant: string, args: PruneForgetLedgerArgs): Promise<RpcOutcome<null>> {
      return settle(async () => {
        await (await this.#forgetLedger(tenant)).prune?.(args);
        return null;
      });
    }

    readLedgerMark(tenant: string, name: string): Promise<RpcOutcome<number>> {
      return settle(async () => (await this.#forgetLedger(tenant)).readMark(name));
    }

    raiseLedgerMark(tenant: string, name: string, value: number): Promise<RpcOutcome<null>> {
      return settle(async () => {
        await (await this.#forgetLedger(tenant)).raiseMark(name, value);
        return null;
      });
    }
  };
};
