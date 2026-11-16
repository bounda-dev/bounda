import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { writeToFile, writeToOutput } from "./export-output.ts";

const encoder = new TextEncoder();

const bodyOf = (chunks: readonly string[], failure?: Error): ReadableStream<Uint8Array> => {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull: (controller) => {
      const chunk = chunks[index++];
      if (chunk !== undefined) controller.enqueue(encoder.encode(chunk));
      else if (failure !== undefined) controller.error(failure);
      else controller.close();
    },
  });
};

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});
const directory = async () => {
  const made = await mkdtemp(join(tmpdir(), "bounda-export-"));
  directories.push(made);
  return made;
};

describe("writing an export", () => {
  it("waits for a stream that holds too much to drain before it reads on", async () => {
    const written: string[] = [];
    let drains = 0;
    const output = new Writable({
      highWaterMark: 1,
      write: (chunk: Buffer, _encoding, done) => {
        written.push(chunk.toString());
        drains += 1;
        setTimeout(done, 1);
      },
    });
    // Split inside "é", which only the decoder makes whole again.
    const bytes = encoder.encode('{"a": "é"}');
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(bytes.slice(0, 8));
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    });
    await writeToOutput(output, body);
    expect(written.join("")).toBe('{"a": "é"}');
    expect(drains).toBeGreaterThan(1);
  });

  it("writes on without waiting while the stream takes it, and ends a character cut short", async () => {
    const written: string[] = [];
    const output = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        written.push(chunk.toString());
        done();
      },
    });
    const bytes = encoder.encode('["é"]');
    await writeToOutput(output, bodyOf([]));
    const cut = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(bytes.slice(0, 3));
        controller.close();
      },
    });
    await writeToOutput(output, cut);
    expect(written.join("")).toBe('["\uFFFD');
  });

  it("leaves the error of a file it could not open as it is", async () => {
    const into = join(await directory(), "missing", "export.json");
    await expect(writeToFile(into, bodyOf(["{}"]))).rejects.toMatchObject({ syscall: "open" });
  });

  it("moves a file into place once whole, and leaves none when the export fails", async () => {
    const into = join(await directory(), "export.json");
    await writeToFile(into, bodyOf(["{", "}"]));
    expect(await readFile(into, "utf8")).toBe("{}");
    const failed = join(await directory(), "export.json");
    await expect(writeToFile(failed, bodyOf(["{"], new Error("changed")))).rejects.toThrow(
      "changed",
    );
    expect(await readdir(join(failed, ".."))).toEqual([]);
  });
});
