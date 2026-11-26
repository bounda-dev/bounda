import {
  type AppStatus,
  type BoundaClient,
  type BoundaError,
  type DataLocation,
  DEFAULT_TENANT,
  type EncryptedFileStatus,
  FILE_ENCRYPTION_RETRY_MS,
  type ForgetLedgerStore,
  type ForgetLedgerTenants,
  type ForgetTenantOptions,
  type FrozenTenantStatus,
  type ListForgetLedgerTenantsArgs,
  type Logger,
  listForgetLedgerTenants,
  listTenantsUnderPreviousMaster,
  migrateTables,
  type NotifiedRecipient,
  type PersonalCategoryName,
  type PrunedTenantForgetLedger,
  pruneTenantForgetLedger,
  type Registry,
  type RewrappedTenantKeys,
  type RotateTenantKeyOptions,
  rewrapTenantKeys,
  TENANT_CHECK_INTERVAL_MS,
  TENANT_FORGOTTEN_EVENT,
  TenantForgottenError,
  type TenantForgottenEvent,
  type TenantForgottenPayload,
  type TenantForgottenResult,
  TenantFrozenError,
  type TenantFrozenResult,
  type TenantKeyStatus,
  type TenantKeyVersions,
  type UnreachedTenant,
  type UnreadableStatus,
  withEncryptedFiles,
} from "@bounda-dev/core";
import type {
  Adapter,
  AdapterDefinition,
  EncryptedFile,
  EphemeralKeys,
  FileEncryption,
  FileEncryptionState,
  FileKey,
  FileKeyAccess,
  ListTenantKeysArgs,
  OpenEncryptedFileArgs,
  PendingRecipientDeclaration,
  StoredFileKey,
  StoredTenantKey,
  Tenancy,
  TenancyStore,
  TenantForgetting,
  TenantKeyRecord,
  TenantKeyStore,
  VersionedTenantKeyRecord,
} from "@bounda-dev/core/adapter";
import {
  type DataLocationOptions,
  type FenceErrorFunction,
  type ForgetLedger,
  fenceError,
  isFenceError,
  nextFence,
  type ReadModelStorage,
  type ReadModelTransactArgs,
  type Storage,
  type TenantFence,
  type TenantFenceState,
  type TenantFenceStore,
} from "@bounda-dev/core/adapter";
import {
  type Config,
  type ConfigForTenantArgs,
  configForTenant,
  defineConfig,
  defineTenantKeyStore,
  type ForgetLedgerSource,
  masterKey,
  type ProjectConfig,
  type ProjectTenants,
  type StoreDefinitionOptions,
  type TenantConfigArgs,
  type TenantKeySource,
  type TenantKeyStoreDefinition,
} from "@bounda-dev/core/config";
import type { LoadedProject } from "@bounda-dev/core/node";
import type { AppEnv } from "@bounda-dev/core/register";
import {
  createTestKeys,
  type ExpectTenantForgottenOptions,
  expectTenantForgotten,
  type TenantNotForgottenError,
} from "@bounda-dev/core/testing";
import { describe, expectTypeOf, it } from "vitest";
import type { Port } from "./fixtures/order-app/app/domain/order/+types/mailer.ts";

declare const sqlite: AdapterDefinition<"sqlite", { path: string }>;
declare const keys: TenantKeySource;
const ports = { order: { inventory: "memory" } } as const;

describe("the tenant's client calls", () => {
  it("forget the tenant, rotate its key and retire its older versions", () => {
    expectTypeOf<BoundaClient["forgetTenant"]>().toEqualTypeOf<
      (tenant: string, options?: ForgetTenantOptions) => Promise<TenantForgottenResult>
    >();
    expectTypeOf<ForgetTenantOptions>().toEqualTypeOf<{
      readonly despiteLegalObligations?: boolean;
    }>();
    expectTypeOf<TenantForgottenResult>().toEqualTypeOf<{
      readonly tenant: string;
      readonly forgottenAt: string;
      readonly eventId: string;
    }>();
    expectTypeOf<BoundaClient["rotateTenantKey"]>().toEqualTypeOf<
      (options?: RotateTenantKeyOptions) => Promise<TenantKeyVersions>
    >();
    expectTypeOf<RotateTenantKeyOptions>().toEqualTypeOf<{ readonly reseal?: boolean }>();
    expectTypeOf<TenantKeyVersions>().toEqualTypeOf<{
      readonly kid: string;
      readonly previous: readonly string[];
      readonly since: string;
    }>();
    expectTypeOf<BoundaClient["retireTenantKeys"]>().toEqualTypeOf<
      () => Promise<readonly string[]>
    >();
    expectTypeOf(DEFAULT_TENANT).toEqualTypeOf<string>();
    expectTypeOf(TENANT_CHECK_INTERVAL_MS).toEqualTypeOf<number>();
  });

  it("freeze and unfreeze the tenant on every client, every write refused meanwhile", () => {
    expectTypeOf<BoundaClient["freezeTenant"]>().toEqualTypeOf<
      (tenant: string) => Promise<TenantFrozenResult>
    >();
    expectTypeOf<BoundaClient["unfreezeTenant"]>().toEqualTypeOf<
      (tenant: string) => Promise<void>
    >();
    expectTypeOf<TenantFrozenResult>().toEqualTypeOf<{
      readonly tenant: string;
      readonly frozenAt: string;
    }>();
    const error = new TenantFrozenError("acme", "2026-01-01T00:00:00.000Z");
    expectTypeOf(error).toExtend<BoundaError>();
    expectTypeOf(error.tenant).toEqualTypeOf<string>();
    expectTypeOf(error.frozenAt).toEqualTypeOf<string>();
    expectTypeOf<AppStatus["frozenTenant"]>().toEqualTypeOf<
      FrozenTenantStatus | null | UnreadableStatus
    >();
    expectTypeOf<FrozenTenantStatus>().toEqualTypeOf<{
      readonly frozenAt: string;
      readonly whole: boolean;
    }>();
  });

  it("put every store behind a fence its writes check in their own transaction", () => {
    expectTypeOf<TenantFenceState>().toEqualTypeOf<"open" | "frozen" | "forgotten">();
    expectTypeOf<TenantFence>().toEqualTypeOf<
      | { readonly state: "open" }
      | { readonly state: "frozen" | "forgotten"; readonly tenant: string; readonly since: string }
    >();
    expectTypeOf<TenantFenceStore>().toEqualTypeOf<{
      read(): Promise<TenantFence>;
      set(fence: TenantFence): Promise<TenantFence>;
    }>();
    expectTypeOf<Storage["fence"]>().toEqualTypeOf<TenantFenceStore>();
    expectTypeOf<Storage["forgotten"]>().toEqualTypeOf<() => Storage>();
    expectTypeOf<ReadModelStorage["fence"]>().toEqualTypeOf<TenantFenceStore>();
    expectTypeOf<ReadModelTransactArgs<object, void>["forgotten"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<ForgetLedger["fence"]>().toEqualTypeOf<TenantFenceStore>();
    expectTypeOf(fenceError).toEqualTypeOf<FenceErrorFunction>();
    expectTypeOf(nextFence).returns.toEqualTypeOf<TenantFence>();
    expectTypeOf(isFenceError).guards.toEqualTypeOf<TenantFrozenError | TenantForgottenError>();
  });

  it("reject with TenantForgottenError once the tenant is forgotten", () => {
    const error = new TenantForgottenError("acme", "2026-01-01T00:00:00.000Z");
    expectTypeOf(error.code).toEqualTypeOf<string>();
    expectTypeOf(error.tenant).toEqualTypeOf<string>();
    expectTypeOf(error.forgottenAt).toEqualTypeOf<string>();
  });

  it("report the tenant's key in the app's status", () => {
    expectTypeOf<AppStatus["tenant"]>().toEqualTypeOf<TenantKeyStatus | null | UnreadableStatus>();
    expectTypeOf<TenantKeyStatus>().toEqualTypeOf<{
      readonly tenant: string;
      readonly forgottenAt: string | null;
      readonly kid: string | null;
      readonly previous: readonly string[];
      readonly master: {
        readonly kid: string;
        readonly previous: readonly string[];
        readonly pending: number;
      };
    }>();
  });
});

describe("the TenantForgotten event", () => {
  it("names the tenant, its categories and the recipients to tell", () => {
    expectTypeOf(TENANT_FORGOTTEN_EVENT).toEqualTypeOf<"TenantForgotten">();
    expectTypeOf<TenantForgottenPayload>().toEqualTypeOf<{
      readonly tenant: string;
      readonly categories: readonly PersonalCategoryName[];
      readonly recipients?: readonly NotifiedRecipient[];
    }>();
    expectTypeOf<TenantForgottenEvent["type"]>().toEqualTypeOf<"TenantForgotten">();
    expectTypeOf<TenantForgottenEvent["payload"]>().toEqualTypeOf<TenantForgottenPayload>();
  });

  it("reaches a recipient's onTenantForgotten, with the persons its port disclosed, in pages", () => {
    expectTypeOf<Port.OnTenantForgottenArgs["event"]>().toEqualTypeOf<TenantForgottenEvent>();
    expectTypeOf<Port.OnTenantForgottenArgs["persons"]>().toEqualTypeOf<
      () => AsyncIterable<string>
    >();
    expectTypeOf<Port.OnTenantForgottenArgs["signal"]>().toEqualTypeOf<AbortSignal>();
  });
});

describe("the tenant in the configuration", () => {
  it("takes a function of the tenant, checked as the configuration it returns", () => {
    const perTenant = defineConfig(({ tenant }) => {
      expectTypeOf(tenant).toEqualTypeOf<string>();
      return { storage: sqlite, ports, runtime: { role: "all" } } as const;
    });
    expectTypeOf(perTenant).parameter(0).toEqualTypeOf<TenantConfigArgs>();
    expectTypeOf(perTenant).toExtend<ProjectConfig>();
    expectTypeOf<ProjectConfig>().toEqualTypeOf<Config | ((args: TenantConfigArgs) => Config)>();
    expectTypeOf(configForTenant({ config: perTenant, tenant: "acme" })).toEqualTypeOf<Config>();
    expectTypeOf<ConfigForTenantArgs>().toEqualTypeOf<{
      readonly config: ProjectConfig;
      readonly tenant: string;
    }>();
    // @ts-expect-error a function's configuration is checked too
    defineConfig(() => ({ storage: sqlite, ports, runtime: { role: "everything" } }));
    // @ts-expect-error and its ports name only what the project has
    defineConfig(() => ({
      storage: sqlite,
      ports: { order: { inventory: "memory", courier: "fake" } },
    }));
  });

  it("names where the tenant's key lives: an adapter of another database or a store of its own", () => {
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        personalData: {
          keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
          tenantKeys: sqlite as unknown as TenantKeySource,
        },
      },
    });
    const own = defineTenantKeyStore(({ env }) => {
      expectTypeOf(env).toEqualTypeOf<Readonly<Record<string, string | undefined>>>();
      return {
        get: async (tenant) => {
          expectTypeOf(tenant).toEqualTypeOf<string>();
          return null;
        },
        put: async (tenant, record, expected) => {
          expectTypeOf(tenant).toEqualTypeOf<string>();
          expectTypeOf(record).toEqualTypeOf<TenantKeyRecord>();
          expectTypeOf(expected).toEqualTypeOf<number | null>();
          return true;
        },
        list: async (args) => {
          expectTypeOf(args).toEqualTypeOf<ListTenantKeysArgs>();
          return { tenants: [], cursor: null };
        },
      };
    });
    expectTypeOf(own).toEqualTypeOf<TenantKeyStoreDefinition>();
    expectTypeOf(own).toExtend<TenantKeySource>();
    const located = defineTenantKeyStore(() => ({}) as TenantKeyStore, {
      location: "eu",
    });
    expectTypeOf(located).toEqualTypeOf<TenantKeyStoreDefinition>();
    expectTypeOf(located.location).toEqualTypeOf<DataLocation | undefined>();
    expectTypeOf<Parameters<typeof defineTenantKeyStore>[1]>().toEqualTypeOf<
      StoreDefinitionOptions | undefined
    >();
    expectTypeOf<StoreDefinitionOptions>().toEqualTypeOf<DataLocationOptions>();
    // @ts-expect-error a location is a jurisdiction's name, such as "eu"
    defineTenantKeyStore(() => ({}) as TenantKeyStore, { location: 7 });
    defineConfig({ storage: sqlite, ports, runtime: { personalData: { tenantKeys: own } } });
    defineConfig({ storage: sqlite, ports, runtime: { personalData: { tenantKeys: keys } } });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error a path is not a store
      runtime: { personalData: { tenantKeys: "./keys/tenant-keys.db" } },
    });
  });
});

describe("the tenant key store", () => {
  it("keeps one record per tenant, written over the revision read", () => {
    expectTypeOf<TenantKeyStore["get"]>().toEqualTypeOf<
      (tenant: string) => Promise<VersionedTenantKeyRecord | null>
    >();
    expectTypeOf<VersionedTenantKeyRecord>().toExtend<TenantKeyRecord>();
    expectTypeOf<VersionedTenantKeyRecord["revision"]>().toEqualTypeOf<number>();
    expectTypeOf<TenantKeyRecord>().toEqualTypeOf<{
      readonly store: string;
      readonly keys: readonly StoredTenantKey[];
      readonly forgotten: TenantForgetting | null;
      readonly files?: readonly StoredFileKey[];
      readonly frozenAt?: string;
      readonly pendingRecipients?: readonly PendingRecipientDeclaration[];
    }>();
    expectTypeOf<PendingRecipientDeclaration>().toEqualTypeOf<{
      readonly id: string;
      readonly renames: readonly { readonly from: string; readonly to: string }[];
      readonly ports: readonly { readonly port: string; readonly categories: readonly string[] }[];
      readonly position: number;
      readonly at: string;
    }>();
    expectTypeOf<StoredFileKey>().toEqualTypeOf<{
      readonly database: string;
      readonly id: string;
      readonly key: string;
      readonly wrappedBy: string;
      readonly createdAt: string;
      readonly appliedAt?: string;
    }>();
    expectTypeOf<StoredTenantKey>().toEqualTypeOf<{
      readonly kid: string;
      readonly fingerprint: string;
      readonly key: string;
      readonly wrappedBy: string;
      readonly createdAt: string;
    }>();
    expectTypeOf<TenantForgetting>().toEqualTypeOf<{
      readonly at: string;
      readonly eventId: string;
      readonly files?: readonly StoredFileKey[];
    }>();
    expectTypeOf<TenancyStore["get"]>().toEqualTypeOf<() => Promise<Tenancy | null>>();
    expectTypeOf<Tenancy["forgottenAt"]>().toEqualTypeOf<string | null>();
  });
});

describe("a database file encrypted under the tenant's keys", () => {
  it("opens through the keys the record keeps, as text the engine takes and keeps nowhere", () => {
    expectTypeOf<Adapter["encryptedFile"]>().toEqualTypeOf<EncryptedFile | undefined>();
    expectTypeOf<EncryptedFile["database"]>().toEqualTypeOf<string>();
    expectTypeOf<EncryptedFile["open"]>().toEqualTypeOf<
      (args: OpenEncryptedFileArgs) => Promise<Adapter>
    >();
    expectTypeOf<OpenEncryptedFileArgs>().toEqualTypeOf<{
      readonly keys: FileKeyAccess;
      readonly logger: Logger;
    }>();
    expectTypeOf<FileKeyAccess["current"]>().toEqualTypeOf<() => Promise<FileKey | null>>();
    expectTypeOf<FileKeyAccess["previous"]>().toEqualTypeOf<() => Promise<readonly FileKey[]>>();
    expectTypeOf<FileKeyAccess["confirm"]>().toEqualTypeOf<(id: string) => Promise<void>>();
    expectTypeOf<FileKeyAccess["tenant"]>().toEqualTypeOf<string>();
    expectTypeOf<FileKey>().toEqualTypeOf<{ readonly id: string; readonly key: string }>();
    expectTypeOf<Adapter["fileEncryption"]>().toEqualTypeOf<FileEncryption | undefined>();
    expectTypeOf<FileEncryption["state"]>().toEqualTypeOf<() => FileEncryptionState>();
    expectTypeOf<FileEncryption["settle"]>().toEqualTypeOf<() => Promise<FileEncryptionState>>();
    expectTypeOf<FileEncryption["refresh"]>().toEqualTypeOf<() => Promise<FileEncryptionState>>();
    expectTypeOf<FileEncryptionState>().toEqualTypeOf<"current" | "earlier" | "clear">();
    expectTypeOf<AppStatus["files"]>().toEqualTypeOf<readonly EncryptedFileStatus[]>();
    expectTypeOf<EncryptedFileStatus>().toEqualTypeOf<{
      readonly database: string;
      readonly file: string;
      readonly state: FileEncryptionState;
    }>();
    expectTypeOf(FILE_ENCRYPTION_RETRY_MS).toEqualTypeOf<number>();
  });

  it("opens for a tool that reads the databases without the app, as migrateTables does", () => {
    expectTypeOf(withEncryptedFiles<number>)
      .parameter(0)
      .toEqualTypeOf<{
        readonly config: Config;
        readonly env: AppEnv;
        readonly tenant?: string;
        readonly logger?: Logger;
        readonly work: (config: Config) => Promise<number>;
      }>();
    expectTypeOf(withEncryptedFiles<number>).returns.toEqualTypeOf<Promise<number>>();
    expectTypeOf(migrateTables).parameter(0).toEqualTypeOf<{
      readonly config: Config;
      readonly env?: AppEnv;
      readonly tenant?: string;
    }>();
  });
});

describe("pruning a forget ledger with no app running", () => {
  it("prunes one tenant from its configuration, saying where it stopped, and lists the store's tenants", () => {
    expectTypeOf(pruneTenantForgetLedger).parameter(0).toEqualTypeOf<{
      readonly config: Config;
      readonly registry: Registry;
      readonly env?: AppEnv;
      readonly tenant?: string;
      readonly store?: ForgetLedgerSource;
      readonly now?: Date;
    }>();
    expectTypeOf(pruneTenantForgetLedger).returns.toEqualTypeOf<
      Promise<PrunedTenantForgetLedger>
    >();
    expectTypeOf<PrunedTenantForgetLedger>().toEqualTypeOf<{
      readonly tenant: string;
      readonly before: string;
      readonly unapplied: boolean;
      readonly named: boolean;
      readonly stranded: boolean;
    }>();
    expectTypeOf(listForgetLedgerTenants).parameter(0).toEqualTypeOf<{
      readonly config: ProjectConfig;
      readonly env?: AppEnv;
      readonly tenant?: string;
      readonly tenants?: readonly string[];
    }>();
    expectTypeOf(listForgetLedgerTenants).returns.toEqualTypeOf<Promise<ForgetLedgerTenants>>();
    expectTypeOf<ForgetLedgerTenants>().toEqualTypeOf<{
      readonly tenants: readonly string[];
      readonly stores: readonly ForgetLedgerStore[];
      readonly unreached: readonly UnreachedTenant[];
    }>();
    expectTypeOf<ForgetLedgerStore>().toEqualTypeOf<{
      readonly store: ForgetLedgerSource;
      readonly tenants: readonly string[];
      readonly named: readonly string[];
    }>();
    // What `loadProject` hands is what the prune takes.
    expectTypeOf<LoadedProject["registry"]>().toExtend<Registry>();
    expectTypeOf<UnreachedTenant>().toEqualTypeOf<{
      readonly tenant: string;
      readonly error: unknown;
    }>();
    // A configuration resolved for one tenant is a project's configuration too.
    expectTypeOf<Config>().toExtend<ListForgetLedgerTenantsArgs["config"]>();
    expectTypeOf<ProjectTenants>().toEqualTypeOf<
      readonly string[] | (() => readonly string[] | Promise<readonly string[]>)
    >();
    expectTypeOf(["acme"] as const).toExtend<ProjectTenants>();
    expectTypeOf(async () => ["acme"]).toExtend<ProjectTenants>();
    expectTypeOf<readonly number[]>().not.toExtend<ProjectTenants>();
    expectTypeOf<LoadedProject["projectConfig"]>().toEqualTypeOf<ProjectConfig>();
    expectTypeOf<LoadedProject["tenants"]>().toEqualTypeOf<() => Promise<readonly string[]>>();
    expectTypeOf<ForgetLedger["tenants"]>().toEqualTypeOf<
      (() => Promise<readonly string[]>) | undefined
    >();
  });
});

describe("rotating the master key across tenants", () => {
  it("rewraps every tenant of the store from the configuration, naming those left", () => {
    expectTypeOf(rewrapTenantKeys).parameter(0).toEqualTypeOf<{
      readonly config: Config;
      readonly env: Readonly<Record<string, string | undefined>>;
    }>();
    expectTypeOf(rewrapTenantKeys).returns.toEqualTypeOf<Promise<RewrappedTenantKeys>>();
    expectTypeOf<RewrappedTenantKeys>().toEqualTypeOf<{
      readonly rewrapped: readonly string[];
      readonly left: readonly { readonly tenant: string; readonly error: unknown }[];
    }>();
    expectTypeOf(listTenantsUnderPreviousMaster).returns.toEqualTypeOf<
      Promise<readonly string[]>
    >();
    expectTypeOf<ListTenantKeysArgs>().toEqualTypeOf<{
      readonly cursor: string | null;
      readonly limit: number;
    }>();
  });
});

describe("testing a forgotten tenant", () => {
  it("checks a test app or an adapter, for values of the tenant's persons", () => {
    expectTypeOf(expectTenantForgotten).returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<ExpectTenantForgottenOptions["values"]>().toEqualTypeOf<
      readonly unknown[] | undefined
    >();
    expectTypeOf<TenantNotForgottenError["problems"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf(createTestKeys()).toEqualTypeOf<EphemeralKeys>();
    expectTypeOf<EphemeralKeys["tenantKeys"]>().toEqualTypeOf<TenantKeyStoreDefinition>();
  });
});
