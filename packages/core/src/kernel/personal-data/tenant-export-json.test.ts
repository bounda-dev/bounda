import { describe, expect, it } from "vitest";
import {
  NO_TENANT_EXPORT_RECORDS,
  TENANT_EXPORT_FORMAT,
  TENANT_EXPORT_VERSION,
  type TenantExportPart,
} from "./tenant-export.ts";
import { readTenantExport, tenantExportJsonLines } from "./tenant-export-json.ts";

const header: TenantExportPart = {
  kind: "header",
  header: {
    format: TENANT_EXPORT_FORMAT,
    version: TENANT_EXPORT_VERSION,
    tenant: "acme",
    exportId: "x-1",
    exportedAt: "2026-01-01T00:00:00.000Z",
    position: 1,
    frozenAt: "2026-01-01T00:00:00.000Z",
    reached: { readModels: { a: 1, b: 1 }, forgetLedger: null },
    categories: {},
    transfers: [],
    readModels: ["a", "b"],
  },
};

const recipient: TenantExportPart = {
  kind: "recipient",
  recipient: {
    port: "customer.crm",
    name: "CRM",
    kind: "processor",
    country: "US",
    transfer: {
      safeguard: "standard-contractual-clauses",
      article: "46(2)(c)",
      regime: "US",
      partialAdequacy: null,
    },
    status: "disclosed",
    categories: [{ name: "contact", basis: "contract" }],
    firstDisclosedAt: "2026-01-01T00:00:00.000Z",
    lastDisclosedAt: "2026-01-01T00:00:00.000Z",
    declared: true,
    persons: 1,
  },
};

const person: TenantExportPart = {
  kind: "person",
  person: {
    personId: "ana",
    lastActiveAt: null,
    forgottenAt: null,
    categories: {},
    restrictions: [],
    recipients: [],
  },
};

const row = (readModel: string): TenantExportPart => ({
  kind: "row",
  readModel,
  row: { key: readModel, data: {}, person: null, categories: {}, restricted: [] },
});

const end = (counts: Partial<typeof NO_TENANT_EXPORT_RECORDS> = {}): TenantExportPart => ({
  kind: "end",
  counts: { ...NO_TENANT_EXPORT_RECORDS, ...counts },
});

const encoder = new TextEncoder();

const bytes = (...chunks: string[]): AsyncIterable<Uint8Array> =>
  (async function* () {
    for (const chunk of chunks) yield encoder.encode(chunk);
  })();

const linesOf = (...parts: readonly unknown[]): string =>
  parts.map((part) => `${JSON.stringify(part)}\n`).join("");

const read = async (body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>) => {
  const parts: TenantExportPart[] = [];
  for await (const part of readTenantExport(body)) parts.push(part);
  return parts;
};

async function* source(...parts: readonly TenantExportPart[]) {
  yield* parts;
}

describe("tenantExportJsonLines", () => {
  it("writes one part per line, each ended by a newline, which read back as they were", async () => {
    const parts = [header, person, row("a"), row("b"), end({ persons: 1, readModelRows: 2 })];
    const text = await new Response(tenantExportJsonLines(source(...parts))).text();
    expect(text).toBe(linesOf(...parts));
    expect(await read(tenantExportJsonLines(source(...parts)))).toEqual(parts);
  });

  it("reads a part only when the stream is read, and closes the parts when it is cancelled", async () => {
    const pulled: string[] = [];
    let closed = false;
    const parts = (async function* () {
      try {
        pulled.push("header");
        yield header;
        pulled.push("person");
        yield person;
      } finally {
        closed = true;
      }
    })();
    const reader = tenantExportJsonLines(parts).getReader();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pulled).toEqual([]);
    await reader.read();
    expect(pulled).toEqual(["header"]);
    await reader.cancel();
    expect(closed).toBe(true);
    expect(pulled).toEqual(["header"]);
  });

  it("cancels parts that cannot be closed", async () => {
    const endless: AsyncIterable<TenantExportPart> = {
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: header }) }),
    };
    const reader = tenantExportJsonLines(endless).getReader();
    await reader.read();
    await expect(reader.cancel()).resolves.toBeUndefined();
  });

  it("errors the stream with what a part rejects with", async () => {
    const body = tenantExportJsonLines(
      (async function* () {
        yield header;
        throw new Error("disk");
      })(),
    );
    await expect(new Response(body).text()).rejects.toThrow("disk");
  });
});

describe("readTenantExport", () => {
  it("reads a whole export, across chunks that split lines and characters", async () => {
    const text = linesOf(
      header,
      person,
      recipient,
      row("a"),
      end({ persons: 1, recipients: 1, readModelRows: 1 }),
    );
    const encoded = encoder.encode(text.replace("ana", "añá"));
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < encoded.length; at += 1) chunks.push(encoded.slice(at, at + 1));
    const parts = await read(
      (async function* () {
        yield* chunks;
      })(),
    );
    expect(parts.map(({ kind }) => kind)).toEqual(["header", "person", "recipient", "row", "end"]);
    expect(parts[1]).toMatchObject({ person: { personId: "añá" } });
  });

  it("reads a last line without its newline", async () => {
    const text = linesOf(header, end()).trimEnd();
    expect((await read(bytes(text))).map(({ kind }) => kind)).toEqual(["header", "end"]);
  });

  it.each([
    ["an empty file", [""], "ends before its end part"],
    ["one without its end", [linesOf(header, person)], "ends before its end part"],
    [
      "one cut within a line",
      [linesOf(header).slice(0, 20)],
      "Line 1 of the tenant export is not JSON",
    ],
    [
      "a line that is not a part",
      [linesOf(header, [1, 2])],
      "Line 2 of the tenant export is not a part",
    ],
    ["a line that is null", [linesOf(header, null)], "Line 2 of the tenant export is not a part"],
    [
      "a part of a kind only every object has",
      [linesOf(header, { kind: "toString" })],
      "unknown kind toString",
    ],
    [
      "a header without its data",
      [linesOf({ kind: "header" })],
      "The header part on line 1 of the tenant export holds no data",
    ],
    [
      "a person whose data is null",
      [linesOf(header, { kind: "person", person: null })],
      "The person part on line 2 of the tenant export holds no data",
    ],
    [
      "a recipient under another name",
      [linesOf(header, person, { kind: "recipient", person: recipient.recipient })],
      "The recipient part on line 3 of the tenant export holds no data",
    ],
    [
      "a row without its read model",
      [linesOf(header, { kind: "row", row: {} })],
      "The row part on line 2 of the tenant export holds no data",
    ],
    [
      "a forget ledger entry under another name",
      [linesOf(header, { kind: "forgetLedgerEntry", forgetLedgerEntry: {} })],
      "The forgetLedgerEntry part on line 2 of the tenant export holds no data",
    ],
    [
      "an end without its counts",
      [linesOf(header, { kind: "end" })],
      "The end part on line 2 of the tenant export holds no data",
    ],
    [
      "a line that is text",
      [linesOf(header, "person")],
      "Line 2 of the tenant export is not a part",
    ],
    [
      "a part whose kind is no text",
      [linesOf(header, { kind: 1 })],
      "Line 2 of the tenant export is not a part",
    ],
    [
      "a part without a kind",
      [linesOf(header, { person })],
      "Line 2 of the tenant export is not a part",
    ],
    ["a part of a kind it does not know", [linesOf(header, { kind: "key" })], "unknown kind key"],
    ["a first part that is no header", [linesOf(person, header)], "does not start with its header"],
    [
      "a second header",
      [linesOf(header, header)],
      "Line 2 of the tenant export is a second header",
    ],
    [
      "a part out of order",
      [linesOf(header, row("a"), person)],
      "Line 3 of the tenant export is a person out of order",
    ],
    [
      "a person after the recipients",
      [linesOf(header, recipient, person)],
      "Line 3 of the tenant export is a person out of order",
    ],
    [
      "a row of a read model the header does not name",
      [linesOf(header, row("c"))],
      "Line 2 of the tenant export is a row of c out of order",
    ],
    [
      "the rows of a read model after the next one's",
      [linesOf(header, row("b"), row("a"))],
      "Line 3 of the tenant export is a row of a out of order",
    ],
    [
      "an end that counts other parts",
      [linesOf(header, person, end())],
      "end counts other parts than it holds",
    ],
    [
      "an end that counts a part of another kind",
      [linesOf(header, person, end({ events: 1 }))],
      "end counts other parts than it holds",
    ],
    [
      "an end that counts a recipient as a person",
      [linesOf(header, recipient, end({ persons: 1 }))],
      "end counts other parts than it holds",
    ],
    [
      "a part after the end",
      [linesOf(header, end(), person)],
      "Line 3 of the tenant export comes after its end",
    ],
    [
      "a second end",
      [linesOf(header, end(), end())],
      "Line 3 of the tenant export comes after its end",
    ],
  ])("refuses %s", async (_name, chunks, message) => {
    await expect(read(bytes(...chunks))).rejects.toThrow(message);
  });

  it("refuses bytes that are no UTF-8, rather than reading them as other text", async () => {
    const body = (async function* () {
      yield encoder.encode(linesOf(header));
      yield new Uint8Array([0x22, 0xff, 0x22, 0x0a]);
    })();
    await expect(read(body)).rejects.toBeInstanceOf(TypeError);
  });

  it("refuses a header of another format or version, naming both", async () => {
    // One written before a freeze cut it, which its header does not say.
    const earlier = { kind: "header", header: { ...header.header, version: 1 } };
    await expect(read(bytes(linesOf(earlier, end())))).rejects.toThrow(
      "The tenant export is in format bounda.tenant-export version 1, not bounda.tenant-export version 5",
    );
    // One whose transfers do not name the legal regime they go to.
    const unnamed = { kind: "header", header: { ...header.header, version: 4 } };
    await expect(read(bytes(linesOf(unnamed, end())))).rejects.toThrow(
      "The tenant export is in format bounda.tenant-export version 4, not bounda.tenant-export version 5",
    );
    const foreign = { kind: "header", header: { ...header.header, format: "other" } };
    await expect(read(bytes(linesOf(foreign, end())))).rejects.toThrow("in format other version 5");
  });

  it("hands each part out as it reads it, before it knows the rest", async () => {
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const part of readTenantExport(bytes(linesOf(header, person)))) {
          seen.push(part.kind);
        }
      })(),
    ).rejects.toThrow("ends before its end part");
    expect(seen).toEqual(["header", "person"]);
  });

  it("reads the rows of each read model in the header's order, skipping one without rows", async () => {
    const failure: TenantExportPart = {
      kind: "subscriberFailure",
      subscriberFailure: {
        subscriber: "projection:a",
        position: 1,
        eventId: "e-1",
        eventType: "T",
        person: null,
        errorName: "Error",
        errorMessage: "x",
        attempts: 1,
        firstFailedAt: "2026-01-01T00:00:00.000Z",
        lastFailedAt: "2026-01-01T00:00:00.000Z",
        resolvedAt: null,
        restricted: [],
      },
    };
    const parts = [
      header,
      failure,
      row("a"),
      row("a"),
      row("b"),
      end({ subscriberFailures: 1, readModelRows: 3 }),
    ];
    expect(await read(bytes(linesOf(...parts)))).toEqual(parts);
    const second = [header, row("b"), end({ readModelRows: 1 })];
    expect(await read(bytes(linesOf(...second)))).toEqual(second);
  });
});
