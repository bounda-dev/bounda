import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { TenantExportCounts } from "@bounda-dev/core";
import type { Output } from "./run.ts";

export interface WriteToOutputFunction {
  (output: Output, body: ReadableStream<Uint8Array>): Promise<void>;
}

// A stream such as standard output says when it holds too much, and the export waits for it to
// drain: the history is read only as fast as it is written.
export const writeToOutput: WriteToOutputFunction = async (output, body) => {
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    const written = output.write(decoder.decode(chunk, { stream: true }));
    if (written === false && output instanceof Writable) await once(output, "drain");
  }
  output.write(decoder.decode());
};

export interface WriteToFileFunction {
  (path: string, body: ReadableStream<Uint8Array>): Promise<void>;
}

// Written beside the file and moved over it once whole, so a failed export leaves no file that
// looks like one; readable by its owner alone, as what it holds is a person's data.
export const writeToFile: WriteToFileFunction = async (path, body) => {
  const partial = `${path}.partial`;
  try {
    await pipeline(
      Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(partial, { mode: 0o600 }),
    );
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
};

export interface FormatTenantExportCountsFunction {
  (counts: TenantExportCounts): string;
}

const COUNTED: readonly (readonly [keyof TenantExportCounts, string])[] = [
  ["persons", "persons"],
  ["recipients", "recipients"],
  ["forgottenRecipients", "recipients of forgotten persons"],
  ["events", "events"],
  ["scheduledCommands", "scheduled commands"],
  ["deadLetters", "dead letters"],
  ["subscriberFailures", "subscriber failures"],
  ["answers", "remembered answers"],
  ["readModelRows", "read model rows"],
  ["forgetLedgerEntries", "forget ledger entries"],
];

export const formatTenantExportCounts: FormatTenantExportCountsFunction = (counts) =>
  COUNTED.map(([key, name]) => `${counts[key]} ${name}`).join(", ");
