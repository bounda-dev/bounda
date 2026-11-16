import { ConcurrencyError, type PersonalDataExportPart } from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { partLines, partsOf } from "../src/parts.ts";

const header: PersonalDataExportPart = {
  kind: "header",
  header: {
    personId: "ada",
    exportedAt: "2026-01-01T00:00:00.000Z",
    position: 2,
    categories: {},
    restrictions: [],
    redactions: [],
    recipients: [],
    readModels: [],
  },
};

const answer: PersonalDataExportPart = {
  kind: "answer",
  answer: {
    idempotencyKey: "k-1\nwith a newline",
    expiresAt: "2026-01-02T00:00:00.000Z",
    outcome: { aggregateType: "order", aggregateId: "o-1", rejected: "Taken", message: "é" },
    restricted: [],
  },
};

const collect = async (parts: AsyncIterable<PersonalDataExportPart>) => {
  const read: PersonalDataExportPart[] = [];
  for await (const part of parts) read.push(part);
  return read;
};

async function* source(
  parts: readonly PersonalDataExportPart[],
  end?: Error,
  closed?: { value: boolean },
): AsyncGenerator<PersonalDataExportPart, void, undefined> {
  try {
    yield* parts;
    if (end !== undefined) throw end;
  } finally {
    if (closed !== undefined) closed.value = true;
  }
}

describe("the parts of a streamed export over RPC", () => {
  it("arrive as they were written, whatever their text holds", async () => {
    expect(await collect(partsOf(partLines(source([header, answer]))))).toEqual([header, answer]);
    // Split anywhere, inside a character too.
    const bytes = new TextEncoder().encode(
      `${JSON.stringify(header)}\n${JSON.stringify(answer)}\n`,
    );
    const at = bytes.indexOf(0xc3) + 1;
    const split = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(bytes.slice(0, at));
        controller.enqueue(bytes.slice(at));
        controller.close();
      },
    });
    expect(await collect(partsOf(split))).toEqual([header, answer]);
  });

  it("are read only as the stream is, never ahead of it", async () => {
    const pulled: string[] = [];
    async function* counted(): AsyncGenerator<PersonalDataExportPart, void, undefined> {
      for (const part of [header, answer]) {
        pulled.push(part.kind);
        yield part;
      }
    }
    const reader = partLines(counted()).getReader();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pulled).toEqual([]);
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pulled).toEqual(["header"]);
    await reader.cancel();
  });

  it("stop parts that cannot be closed without failing", async () => {
    const parts: AsyncIterable<PersonalDataExportPart> = {
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: header }) }),
    };
    const reader = partLines(parts).getReader();
    await reader.read();
    await expect(reader.cancel()).resolves.toBeUndefined();
  });

  it("end with the refusal a Bounda error carries, after the parts before it", async () => {
    const read: PersonalDataExportPart[] = [];
    const reading = (async () => {
      for await (const part of partsOf(
        partLines(
          source(
            [header],
            new ConcurrencyError({ streamId: "bounda:ada", expectedVersion: 1, actualVersion: 2 }),
          ),
        ),
      )) {
        read.push(part);
      }
    })();
    await expect(reading).rejects.toMatchObject({
      name: "ConcurrencyError",
      code: "CONCURRENCY_CONFLICT",
    });
    // As it crossed RPC: the refusal, not the object thrown on the other side.
    await expect(reading).rejects.not.toBeInstanceOf(ConcurrencyError);
    expect(read).toEqual([header]);
  });

  it("error the stream for any other error", async () => {
    const parts = partsOf(partLines(source([header], new Error("disk"))));
    await expect(collect(parts)).rejects.toThrow("disk");
  });

  it("stop the export when the reader stops", async () => {
    const closed = { value: false };
    for await (const part of partsOf(partLines(source([header, answer], undefined, closed)))) {
      expect(part).toEqual(header);
      break;
    }
    expect(closed.value).toBe(true);
  });

  it("refuse a stream that ends within a part", async () => {
    const cut = new Blob([JSON.stringify(header).slice(0, 10)]).stream();
    await expect(collect(partsOf(cut))).rejects.toThrow(
      "A personal data export ended within a part",
    );
  });
});
