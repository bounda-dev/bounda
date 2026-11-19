import { type RpcRefusal, refusalOf, refused } from "./outcome.ts";

// The last line of a stream whose parts failed with a `BoundaError`, which the client throws as
// `unwrap` throws a refusal.
interface RefusalLine {
  readonly kind: "refusal";
  readonly refusal: RpcRefusal;
}

// A part of a person's export or of a tenant's, each with its kind.
interface Part {
  readonly kind: string;
}

const isRefusal = <Of extends Part>(line: Of | RefusalLine): line is RefusalLine =>
  line.kind === "refusal";

export interface PartLinesFunction {
  <Of extends Part>(parts: AsyncIterable<Of>): ReadableStream<Uint8Array>;
}

// One JSON per line, read only as the stream is: a `BoundaError` ends it with a line that carries
// it, any other error errors the stream, and cancelling the stream closes the parts.
export const partLines: PartLinesFunction = (parts) => {
  const iterator = parts[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        let next: IteratorResult<Part>;
        try {
          next = await iterator.next();
        } catch (error) {
          const refusal = refusalOf(error);
          if (refusal === null) throw error;
          const line: RefusalLine = { kind: "refusal", refusal };
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          controller.close();
          return;
        }
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

export interface PartsOfFunction {
  <Of extends Part>(lines: ReadableStream<Uint8Array>): AsyncGenerator<Of, void, undefined>;
}

// Stopping early cancels the stream, and with it the export on the object.
export const partsOf: PartsOfFunction = async function* <Of extends Part>(
  lines: ReadableStream<Uint8Array>,
) {
  const reader = lines.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let start = 0;
      let end = pending.indexOf("\n");
      while (end !== -1) {
        const line = JSON.parse(pending.slice(start, end)) as Of | RefusalLine;
        start = end + 1;
        if (isRefusal(line)) throw refused(line.refusal);
        yield line;
        end = pending.indexOf("\n", start);
      }
      pending = pending.slice(start);
      if (done) {
        if (pending !== "") throw new Error("An export ended within a part");
        return;
      }
    }
  } finally {
    // Stops the export when the reader stopped first; nothing to stop at the end.
    await reader.cancel().catch(() => undefined);
  }
};
