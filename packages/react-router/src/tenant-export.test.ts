import {
  type BoundaClient,
  ConcurrencyError,
  readTenantExport,
  type TenantExportPart,
  ValidationError,
} from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { tenantExportResponse } from "./tenant-export.ts";

const header: TenantExportPart = {
  kind: "header",
  header: {
    format: "bounda.tenant-export",
    version: 4,
    tenant: "acme",
    exportId: "x-1",
    exportedAt: "2026-01-01T00:00:00.000Z",
    position: 0,
    frozenAt: "2026-01-01T00:00:00.000Z",
    reached: { readModels: {}, forgetLedger: null },
    categories: {},
    transfers: [],
    readModels: [],
  },
};

const end: TenantExportPart = {
  kind: "end",
  counts: {
    persons: 0,
    recipients: 0,
    events: 0,
    scheduledCommands: 0,
    deadLetters: 0,
    subscriberFailures: 0,
    answers: 0,
    readModelRows: 0,
    forgetLedgerEntries: 0,
  },
};

const clientOf = (
  parts: () => AsyncGenerator<TenantExportPart, void, undefined>,
  asked: string[] = [],
): Pick<BoundaClient, "exportTenant"> => ({
  exportTenant: async (tenant) => {
    if (tenant !== "acme") throw new ValidationError("another tenant", []);
    asked.push(tenant);
    return parts();
  },
});

describe("tenantExportResponse", () => {
  it("answers the export's JSON Lines, streamed, to be saved and never cached", async () => {
    const asked: string[] = [];
    const response = await tenantExportResponse(
      clientOf(async function* () {
        yield header;
        yield end;
      }, asked),
      "acme",
    );
    expect(asked).toEqual(["acme"]);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "application/jsonl; charset=utf-8",
      "content-disposition": 'attachment; filename="tenant-export.jsonl"',
      "cache-control": "no-store",
    });
    const read: TenantExportPart[] = [];
    for await (const part of readTenantExport(response.body as ReadableStream<Uint8Array>)) {
      read.push(part);
    }
    expect(read).toEqual([header, end]);
  });

  it("takes what init adds, its headers over its own", async () => {
    const response = await tenantExportResponse(
      clientOf(async function* () {
        yield header;
      }),
      "acme",
      { status: 201, headers: { "content-disposition": 'attachment; filename="acme.jsonl"' } },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="acme.jsonl"');
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a refusal before the response is made", async () => {
    await expect(
      tenantExportResponse(
        clientOf(async function* () {
          yield header;
        }),
        "another",
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("cuts the body short of its end when the export fails while it reads", async () => {
    const response = await tenantExportResponse(
      clientOf(async function* () {
        yield header;
        throw new ConcurrencyError({ streamId: "$all", expectedVersion: 0, actualVersion: 1 });
      }),
      "acme",
    );
    await expect(response.text()).rejects.toBeInstanceOf(ConcurrencyError);
  });
});
