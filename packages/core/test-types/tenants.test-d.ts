import {
  type AppStatus,
  type BoundaClient,
  DEFAULT_TENANT,
  type EncryptedFileStatus,
  FILE_ENCRYPTION_RETRY_MS,
  type ForgetTenantOptions,
  type Logger,
  listTenantsUnderPreviousMaster,
  migrateTables,
  type NotifiedRecipient,
  type PersonalCategoryName,
  type RewrappedTenantKeys,
  type RotateTenantKeyOptions,
  rewrapTenantKeys,
  TENANT_CHECK_INTERVAL_MS,
  TENANT_FORGOTTEN_EVENT,
  TenantForgottenError,
  type TenantForgottenEvent,
  type TenantForgottenPayload,
  type TenantForgottenResult,
  type TenantKeyStatus,
  type TenantKeyVersions,
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
  type Config,
  type ConfigForTenantArgs,
  configForTenant,
  defineConfig,
  defineTenantKeyStore,
  masterKey,
  type ProjectConfig,
  type TenantConfigArgs,
  type TenantKeySource,
  type TenantKeyStoreDefinition,
} from "@bounda-dev/core/config";
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
