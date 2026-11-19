import { describe, expect, it } from "vitest";
import { createMemoryForgetLedgers } from "../../memory/forget-ledger.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import { defineForgetLedger } from "./forget-ledger.ts";
import { defineTenantKeyStore } from "./tenant-key-source.ts";

describe("defineTenantKeyStore and defineForgetLedger", () => {
  it("keep where the store says it keeps what it holds, and nothing when it says nothing", () => {
    const keys = () => createMemoryTenantKeyStore();
    const ledger = () => createMemoryForgetLedgers().ledgerOf(undefined);
    expect(defineTenantKeyStore(keys, { location: "jurisdiction eu" })).toEqual({
      kind: "bounda-tenant-key-store",
      create: keys,
      location: "jurisdiction eu",
    });
    expect(defineForgetLedger(ledger, { location: "jurisdiction eu" })).toEqual({
      kind: "bounda-forget-ledger",
      create: ledger,
      location: "jurisdiction eu",
    });
    for (const definition of [
      defineTenantKeyStore(keys),
      defineTenantKeyStore(keys, {}),
      defineForgetLedger(ledger),
      defineForgetLedger(ledger, {}),
    ]) {
      expect(Object.keys(definition)).toEqual(["kind", "create"]);
    }
  });
});
