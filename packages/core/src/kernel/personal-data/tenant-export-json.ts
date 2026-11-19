import {
  countTenantRecord,
  NO_TENANT_EXPORT_RECORDS,
  TENANT_EXPORT_FORMAT,
  TENANT_EXPORT_VERSION,
  type TenantExportCounts,
  type TenantExportPart,
  type TenantExportRecord,
} from "./tenant-export.ts";

export interface TenantExportJsonLinesFunction {
  (parts: AsyncIterable<TenantExportPart>): ReadableStream<Uint8Array>;
}

/**
 * The tenant export as JSON Lines, one part per line in the order it comes, `\n` after each: a
 * body for a file or a response, written as the parts come, whatever the tenant holds. A part is
 * read only when the stream is, never ahead of it, and cancelling the stream closes the parts. A
 * part that rejects errors the stream, which then ends without its `end` line: `readTenantExport`
 * refuses what it wrote.
 */
export const tenantExportJsonLines: TenantExportJsonLinesFunction = (parts) => {
  const iterator = parts[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        const next = await iterator.next();
        if (next.done === true) controller.close();
        else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
      },
      cancel: async () => {
        await iterator.return?.();
      },
    },
    { highWaterMark: 0 },
  );
};

const KINDS: ReadonlySet<string> = new Set<TenantExportRecord["kind"]>([
  "person",
  "event",
  "scheduledCommand",
  "deadLetter",
  "subscriberFailure",
  "answer",
  "row",
  "forgetLedgerEntry",
]);

// The part a line holds, whose kind and first-level shape are checked; what lies inside a record is
// the app's data, handed on as it is.
const partOf = (line: string, number: number): TenantExportPart => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`Line ${number} of the tenant export is not JSON`);
  }
  // Any JSON but `null` reads a `kind`, which only an object of a part has as text.
  const kind = (parsed as { readonly kind?: unknown } | null)?.kind;
  if (typeof kind !== "string") {
    throw new Error(`Line ${number} of the tenant export is not a part`);
  }
  if (kind === "header" || kind === "end" || KINDS.has(kind)) return parsed as TenantExportPart;
  throw new Error(`Line ${number} of the tenant export is a part of unknown kind ${kind}`);
};

const sameCounts = (a: TenantExportCounts, b: TenantExportCounts): boolean =>
  (Object.keys(NO_TENANT_EXPORT_RECORDS) as (keyof TenantExportCounts)[]).every(
    (key) => a[key] === b[key],
  );

async function* lines(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    let start = 0;
    let end = pending.indexOf("\n");
    while (end !== -1) {
      yield pending.slice(start, end);
      start = end + 1;
      end = pending.indexOf("\n", start);
    }
    pending = pending.slice(start);
  }
  pending += decoder.decode();
  if (pending !== "") yield pending;
}

export interface ReadTenantExportFunction {
  (
    body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  ): AsyncGenerator<TenantExportPart, void, undefined>;
}

/**
 * Reads back what `tenantExportJsonLines` wrote, a part at a time, and checks the export is whole:
 * a header of this format and version first, parts of known kinds in their order, every row of a
 * read model the header names, and last an `end` whose counts are those of the parts read, with
 * nothing after it. Throws as soon as one of these fails, so a reader that reaches the end without
 * a throw read the whole export: what to check before `forgetTenant` destroys the tenant's keys.
 */
export const readTenantExport: ReadTenantExportFunction = async function* (body) {
  const order = [
    "header",
    "person",
    "event",
    "scheduledCommand",
    "deadLetter",
    "subscriberFailure",
    "answer",
    "row",
    "forgetLedgerEntry",
    "end",
  ];
  let number = 0;
  let at = -1;
  let readModels: readonly string[] = [];
  let readModel = -1;
  let counts = NO_TENANT_EXPORT_RECORDS;
  let ended = false;
  for await (const line of lines(body)) {
    number += 1;
    if (ended) throw new Error(`Line ${number} of the tenant export comes after its end`);
    const part = partOf(line, number);
    const index = order.indexOf(part.kind);
    if (index < at) {
      throw new Error(`Line ${number} of the tenant export is a ${part.kind} out of order`);
    }
    if (at === -1 && part.kind !== "header") {
      throw new Error("The tenant export does not start with its header");
    }
    if (part.kind === "header") {
      if (at !== -1) throw new Error(`Line ${number} of the tenant export is a second header`);
      if (
        part.header.format !== TENANT_EXPORT_FORMAT ||
        part.header.version !== TENANT_EXPORT_VERSION
      ) {
        throw new Error(
          `The tenant export is in format ${String(part.header.format)} version ${String(part.header.version)}, not ${TENANT_EXPORT_FORMAT} version ${TENANT_EXPORT_VERSION}`,
        );
      }
      readModels = part.header.readModels;
    } else if (part.kind === "end") {
      if (!sameCounts(part.counts, counts)) {
        throw new Error("The tenant export's end counts other parts than it holds");
      }
      ended = true;
    } else {
      if (part.kind === "row") {
        const of = readModels.indexOf(part.readModel);
        if (of === -1 || of < readModel) {
          throw new Error(
            `Line ${number} of the tenant export is a row of ${part.readModel} out of order`,
          );
        }
        readModel = of;
      }
      counts = countTenantRecord(counts, part);
    }
    at = index;
    yield part;
  }
  if (!ended) throw new Error("The tenant export ends before its end part: it is not whole");
};
