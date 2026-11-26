import { describe, expect, it } from "vitest";
import type { Table } from "../../adapter/storage/table.ts";
import { createMemoryForgetLedgers } from "../../memory/forget-ledger.ts";
import { memory } from "../../memory/index.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { createApp } from "../app.ts";
import { orderAggregateEntry } from "../test-support.ts";
import { defineForgetLedger } from "./forget-ledger.ts";
import { masterKey } from "./master-key.ts";
import { defineTenantKeyStore } from "./tenant-key-source.ts";
import { DEFAULT_TENANT } from "./tenant-keys.ts";

const project = ({
  event,
  table,
}: {
  event: { aggregateId: string; payload: { total: number } };
  table: Table<{ orderId: string; total: number }>;
}) => table.upsert({ orderId: event.aggregateId, total: event.payload.total });

const registry = {
  aggregates: { order: orderAggregateEntry() },
  readModels: {
    // Holds personal data: its transfer concerns every person.
    orderNotes: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          orderId: f.string().primaryKey().notPersonal(),
          customerId: f.string().person(),
          note: f.string().optional().personal(),
        }),
      },
      projections: {},
      queries: {},
    },
    // Holds none: kept abroad, it transfers no personal data.
    orderTotals: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          orderId: f.string().primaryKey().notPersonal(),
          total: f.number(),
        }),
      },
      projections: { order: { orderPlaced: { project } } },
      queries: {},
    },
  },
} as unknown as Registry;

const MASTER = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

describe("a person's export", () => {
  it("tells of every store kept out of the storage's location, its regime and its safeguard (article 15(2))", async () => {
    const tenantKeys = createMemoryTenantKeyStore();
    const app = await createApp({
      registry,
      env: { BOUNDA_MASTER_KEY: MASTER },
      config: {
        storage: memory({ location: "eu" }),
        readModels: {
          orderNotes: memory({ location: "ch", safeguard: "adequacy" }),
          orderTotals: memory({ location: "us", safeguard: "standard-contractual-clauses" }),
        },
        ports: { order: { notifier: "memory" } },
        runtime: {
          personalData: {
            keyWrapper: masterKey({
              from: "BOUNDA_MASTER_KEY",
              location: "us",
              safeguard: "standard-contractual-clauses",
            }),
            tenantKeys: defineTenantKeyStore(() => tenantKeys, {
              location: "ch",
              safeguard: "adequacy",
            }),
            forgetLedger: {
              store: defineForgetLedger(
                ({ tenant }) => createMemoryForgetLedgers().ledgerOf(tenant),
                { location: "fedramp", safeguard: "binding-corporate-rules" },
              ),
            },
          },
        },
      },
    });
    const transfers = [
      {
        store: "read-model",
        readModel: "orderNotes",
        location: "ch",
        safeguard: "adequacy",
        article: "45",
        regime: "CH",
      },
      {
        store: "master-key",
        readModel: null,
        location: "us",
        safeguard: "standard-contractual-clauses",
        article: "46(2)(c)",
        regime: "US",
      },
      {
        store: "tenant-keys",
        readModel: null,
        location: "ch",
        safeguard: "adequacy",
        article: "45",
        regime: "CH",
      },
      {
        store: "forget-ledger",
        readModel: null,
        // A location names where; the regime, which law it is kept under.
        location: "fedramp",
        safeguard: "binding-corporate-rules",
        article: "47",
        regime: "US",
      },
    ];
    expect((await app.exportPersonalData("ana")).transfers).toEqual(transfers);
    for await (const part of await app.streamPersonalData("ana")) {
      expect(part.kind === "header" ? part.header.transfers : null).toEqual(transfers);
      break;
    }
    // The tenant's export names the same, in its header, for the controller it is handed back to.
    await app.freezeTenant(DEFAULT_TENANT);
    for await (const part of await app.exportTenant(DEFAULT_TENANT)) {
      expect(part.kind === "header" ? part.header.transfers : null).toEqual(transfers);
      break;
    }
    await app.stop();
  });

  it("tells of none when every store is kept where the storage is", async () => {
    const app = await createApp({
      registry,
      config: {
        storage: memory({ location: "eu" }),
        readModels: {
          orderNotes: memory({ location: "eu" }),
          orderTotals: memory({ location: "eu" }),
        },
        ports: { order: { notifier: "memory" } },
      },
    });
    expect((await app.exportPersonalData("ana")).transfers).toEqual([]);
    await app.stop();
  });
});
