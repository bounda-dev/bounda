import { describe, expect, it } from "vitest";
import { opaqueColumnsOf } from "../storage/inspection.ts";
import {
  createSqlTenantKeyStore,
  parseTenantKeyRecord,
  tenantKeyRecordText,
} from "./tenant-key-store.ts";

// A database that answers with `rows`, and a schema that fails `failures` times first.
const storeOver = (rows: readonly Record<string, unknown>[], failures = 0) => {
  let attempts = 0;
  let left = failures;
  const store = createSqlTenantKeyStore({
    db: { all: async () => rows, run: async () => undefined } as never,
    table: '"tenant_keys"',
    dialect: { placeholder: (index: number) => `?${index}` },
    ensureSchema: async () => {
      attempts += 1;
      if (left > 0) {
        left -= 1;
        throw new Error("the database is down");
      }
    },
    close: async () => undefined,
  });
  return { store, attempts: () => attempts };
};

describe("createSqlTenantKeyStore", () => {
  it("creates its table again on the next call after it failed to, and once it did, never again", async () => {
    const { store, attempts } = storeOver([], 1);
    await expect(store.get("acme")).rejects.toThrow("the database is down");
    expect(await store.get("acme")).toBeNull();
    expect(await store.list({ cursor: null, limit: 1 })).toEqual({ tenants: [], cursor: null });
    expect(attempts()).toBe(2);
  });

  it("refuses a row it did not write, naming the column", async () => {
    await expect(storeOver([{ revision: 1, record: 1 }]).store.get("acme")).rejects.toThrow(
      new Error("A tenant key record holds no text in record"),
    );
    await expect(storeOver([{ tenant: 1 }]).store.list({ cursor: null, limit: 1 })).rejects.toThrow(
      new Error("A tenant key record holds no text in tenant"),
    );
  });
});

const version = {
  kid: "t-1",
  fingerprint: "fp",
  key: "wrapped",
  wrappedBy: "m-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const record = { store: "s-1", keys: [version], forgotten: null };

const file = {
  database: "app.db",
  id: "f-1",
  key: "wrapped",
  wrappedBy: "t-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("parseTenantKeyRecord", () => {
  it("reads back what tenantKeyRecordText wrote, forgotten or not", () => {
    expect(parseTenantKeyRecord(tenantKeyRecordText(record), 3)).toEqual({
      ...record,
      revision: 3,
    });
    const forgotten = { store: "s-1", keys: [], forgotten: { at: "2026-02-01", eventId: "e-1" } };
    expect(parseTenantKeyRecord(tenantKeyRecordText(forgotten), 4)).toEqual({
      ...forgotten,
      revision: 4,
    });
    const { forgotten: _, ...without } = record;
    expect(parseTenantKeyRecord(JSON.stringify(without), 1).forgotten).toBeNull();
    const frozen = { ...record, frozenAt: "2026-03-01T00:00:00.000Z" };
    expect(parseTenantKeyRecord(tenantKeyRecordText(frozen), 5)).toEqual({
      ...frozen,
      revision: 5,
    });
    expect(tenantKeyRecordText(record)).not.toContain("frozenAt");
    expect(parseTenantKeyRecord(JSON.stringify({ ...record, frozenAt: 1 }), 6)).not.toHaveProperty(
      "frozenAt",
    );
  });

  it("reads back the keys of the tenant's files, in force or kept for its recipients", () => {
    const withFiles = { ...record, files: [file, { ...file, id: "f-2", appliedAt: "2026-01-02" }] };
    expect(parseTenantKeyRecord(tenantKeyRecordText(withFiles), 2)).toEqual({
      ...withFiles,
      revision: 2,
    });
    const forgotten = {
      store: "s-1",
      keys: [],
      forgotten: { at: "2026-02-01", eventId: "e-1", files: [file] },
    };
    expect(parseTenantKeyRecord(tenantKeyRecordText(forgotten), 3)).toEqual({
      ...forgotten,
      revision: 3,
    });
    // Only what the record holds: nothing it does not.
    expect(
      tenantKeyRecordText({ ...record, files: [{ ...file, extra: 1 } as never] }),
    ).not.toContain("extra");
  });

  it.each<readonly [unknown, string]>([
    [{ ...record, keys: "none" }, "A tenant key record holds no keys"],
    [{ ...record, store: 1 }, "A tenant key record holds no text in store"],
    ...(["kid", "fingerprint", "key", "wrappedBy", "createdAt"] as const).map(
      (field) =>
        [
          { ...record, keys: [{ ...version, [field]: 1 }] },
          `A tenant key record holds no text in ${field}`,
        ] as const,
    ),
    [
      { ...record, forgotten: { at: 1, eventId: "e-1" } },
      "A tenant key record holds no text in at",
    ],
    [
      { ...record, forgotten: { at: "2026-02-01", eventId: null } },
      "A tenant key record holds no text in eventId",
    ],
    [{ ...record, files: "none" }, "A tenant key record holds no list in files"],
    ...(["database", "id", "key", "wrappedBy", "createdAt", "appliedAt"] as const).map(
      (field) =>
        [
          { ...record, files: [{ ...file, [field]: 1 }] },
          `A tenant key record holds no text in ${field}`,
        ] as const,
    ),
  ])("refuses a record whose shape is not one it wrote: %j", (stored, message) => {
    expect(() => parseTenantKeyRecord(JSON.stringify(stored), 1)).toThrow(new Error(message));
  });
});

describe("opaqueColumnsOf", () => {
  it("names the record of a tenant's key as key material, compared whole", () => {
    expect(opaqueColumnsOf("tenantKeys", ["tenant", "record", "revision"])).toEqual(["record"]);
    expect(opaqueColumnsOf("tenancy", ["tenant", "store"])).toEqual([]);
  });
});
