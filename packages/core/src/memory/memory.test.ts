import { describe, expect, it } from "vitest";
import { isAdapter } from "../adapter/adapter.ts";
import {
  type ContractRow,
  checkpointStoreContract,
  contractFields,
  deadLetterStoreContract,
  eventStoreContract,
  inboxLedgerContract,
  readModelRebuildContract,
  schedulerContract,
  tableContract,
} from "../adapter/testing/index.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import { silentLogger } from "../contracts/logger.ts";
import { fieldBuilder as f } from "../modules/view.ts";
import { memory } from "./index.ts";

const storage = async () => memory().createStorage({ logger: silentLogger });

describe("memory adapter", () => {
  eventStoreContract({ create: async () => (await storage()).eventStore });
  checkpointStoreContract({ create: async () => (await storage()).checkpointStore });
  inboxLedgerContract({ create: async () => (await storage()).inboxLedger });
  deadLetterStoreContract({ create: async () => (await storage()).deadLetterStore });
  schedulerContract({ create: async () => (await storage()).scheduler });
  tableContract({
    create: async () => {
      const ports = await memory().createReadModel<ContractRow>({
        name: "order-summary",
        fields: contractFields,
        logger: silentLogger,
      });
      return ports.table;
    },
  });
  readModelRebuildContract({ create: async () => memory() });

  it("is a full adapter with one storage per instance, isolated from other instances", async () => {
    const adapter = memory();
    expect(isAdapter(adapter)).toBe(true);
    expect(adapter).toMatchObject({ kind: "bounda-adapter", name: "memory", options: {} });
    const first = await adapter.createStorage({ logger: silentLogger });
    const again = await adapter.createStorage({ logger: silentLogger });
    const second = await memory().createStorage({ logger: silentLogger });
    await first.checkpointStore.set("policies", 4);
    expect(await again.checkpointStore.get("policies")).toBe(4);
    expect(await second.checkpointStore.get("policies")).toBe(0);
    await first.close();
  });

  it("opens the same read model twice on the same rows", async () => {
    const adapter = memory();
    const first = await adapter.createReadModel<ContractRow>({
      name: "order-summary",
      fields: contractFields,
      logger: silentLogger,
    });
    const second = await adapter.createReadModel<ContractRow>({
      name: "order-summary",
      fields: contractFields,
      logger: silentLogger,
    });
    await first.table.insert({ orderId: "1", customerId: "c", status: "placed", total: 1 });
    expect(await second.table.count()).toBe(1);
  });

  it("refuses SQL through its read client and points at table instead", async () => {
    const ports = await memory().createReadModel({
      name: "order-summary",
      fields: contractFields,
      logger: silentLogger,
    });
    await expect(ports.client.get("SELECT 1")).rejects.toBeInstanceOf(ConfigurationError);
    await expect(ports.client.all("SELECT 1")).rejects.toThrow(/table\.findOne/);
    expect(ports.client.raw).toBe(ports.table);
  });

  it("requires a primary key in the view", async () => {
    await expect(
      memory().createReadModel({
        name: "no-key",
        fields: { total: f.number() },
        logger: silentLogger,
      }),
    ).rejects.toThrow('Read model "no-key" declares no primary key field');
  });
});
