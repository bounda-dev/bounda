import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { silentLogger } from "@bounda-dev/core";
import type { Adapter } from "@bounda-dev/core/adapter";
import {
  type ContractRow,
  checkpointStoreContract,
  contractFields,
  deadLetterStoreContract,
  eventStoreContract,
  forgetLedgerContract,
  idempotencyStoreContract,
  inboxLedgerContract,
  personalKeyStoreContract,
  personStoreContract,
  readModelRebuildContract,
  readModelTransactionContract,
  schedulerContract,
  snapshotStoreContract,
  storageSchemaContract,
  storageTransactionContract,
  tableContract,
  viewContract,
} from "@bounda-dev/core/adapter/testing";
import { describe, expect, it } from "vitest";
import { durableObjectAdapter } from "../src/adapter.ts";
import { insideObject } from "./inside-object.ts";

const freshAdapter = async (): Promise<Adapter> => {
  const stub = env.BARE.get(env.BARE.newUniqueId());
  const adapter = await runInDurableObject(stub, (_instance, state) =>
    durableObjectAdapter({ storage: state.storage, options: {} }),
  );
  return insideObject(stub, adapter);
};

const freshStorage = async () => (await freshAdapter()).createStorage();

const freshObject = async () => {
  const stub = env.BARE.get(env.BARE.newUniqueId());
  const adapter = await runInDurableObject(stub, (_instance, state) =>
    durableObjectAdapter({ storage: state.storage, options: {} }),
  );
  return {
    adapter: insideObject(stub, adapter),
    prefix: "bounda_",
    execute: (statement: string) =>
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<Record<string, SqlStorageValue>>(statement).toArray(),
      ),
  };
};

describe("the Durable Object adapter", () => {
  eventStoreContract({ create: freshStorage, concurrent: false });
  checkpointStoreContract({ create: async () => (await freshStorage()).checkpointStore });
  inboxLedgerContract({ create: async () => (await freshStorage()).inboxLedger });
  deadLetterStoreContract({ create: async () => (await freshStorage()).deadLetterStore });
  schedulerContract({ create: async () => (await freshStorage()).scheduler });
  idempotencyStoreContract({ create: freshStorage });
  snapshotStoreContract({ create: freshStorage });
  storageTransactionContract({ create: freshStorage });
  personalKeyStoreContract({ create: async () => (await freshStorage()).personalKeys });
  personStoreContract({ create: async () => (await freshStorage()).persons });
  forgetLedgerContract({
    create: async () => {
      const adapter = await freshAdapter();
      return (tenant) => adapter.createForgetLedger({ tenant });
    },
  });
  tableContract({
    create: async () =>
      (
        await (
          await freshAdapter()
        ).createReadModel<ContractRow>({
          name: "orderSummary",
          fields: contractFields,
          logger: silentLogger,
        })
      ).table,
  });
  viewContract({ create: freshAdapter });
  readModelRebuildContract({ create: freshAdapter, concurrent: false });
  readModelTransactionContract({
    create: freshAdapter,
    locking: "single-writer",
    concurrent: false,
  });
  storageSchemaContract({ create: freshObject, dialect: "sqlite", concurrent: false });
});

describe("the Durable Object adapter's schema versions", () => {
  it("keeps one per table prefix in an object, and every object, a tenant, its own", async () => {
    const tenant = env.BARE.get(env.BARE.idFromName("tenant-a"));
    const other = env.BARE.get(env.BARE.idFromName("tenant-b"));
    const versionTables = (stub: typeof tenant) =>
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%migrations' ORDER BY name",
          )
          .toArray()
          .map(({ name }) => name),
      );
    for (const tablePrefix of ["one_", "two_"]) {
      const adapter = await runInDurableObject(tenant, (_instance, state) =>
        durableObjectAdapter({ storage: state.storage, options: { tablePrefix } }),
      );
      await (await insideObject(tenant, adapter).createStorage()).close();
    }
    expect(await versionTables(tenant)).toEqual(["one_migrations", "two_migrations"]);
    expect(await versionTables(other)).toEqual([]);
  });
});
