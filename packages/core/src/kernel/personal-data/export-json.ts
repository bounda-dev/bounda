import type { PersonalDataExportPart, PersonalDataExportRecord } from "./export.ts";

export interface PersonalDataExportJsonFunction {
  (parts: AsyncIterable<PersonalDataExportPart>): ReadableStream<Uint8Array>;
}

const SECTIONS = [
  ["redaction", "redactions"],
  ["event", "events"],
  ["scheduledCommand", "scheduledCommands"],
  ["deadLetter", "deadLetters"],
  ["subscriberFailure", "subscriberFailures"],
  ["answer", "answers"],
] as const;

const READ_MODELS = SECTIONS.length;

const recordOf = (part: Exclude<PersonalDataExportRecord, { readonly kind: "row" }>): unknown => {
  switch (part.kind) {
    case "redaction":
      return part.redaction;
    case "event":
      return part.event;
    case "scheduledCommand":
      return part.scheduledCommand;
    case "deadLetter":
      return part.deadLetter;
    case "subscriberFailure":
      return part.subscriberFailure;
    case "answer":
      return part.answer;
  }
};

// As `JSON.stringify(value, null, 2)` writes it nested `indent` deep: a newline is only ever
// layout, since one inside a string is escaped.
const indented = (value: unknown, indent: string): string =>
  JSON.stringify(value, null, 2).replaceAll("\n", `\n${indent}`);

// An array written one item at a time, as `JSON.stringify(array, null, 2)` writes it.
const arrayWriter = (indent: string) => {
  let empty = true;
  return {
    open: (): void => {
      empty = true;
    },
    item: (value: unknown): string => {
      const text = `${empty ? "" : ","}\n${indent}  ${indented(value, `${indent}  `)}`;
      empty = false;
      return text;
    },
    close: (): string => (empty ? "]" : `\n${indent}]`),
  };
};

const outOfOrder = (part: PersonalDataExportRecord): Error =>
  new Error(`A personal data export has a ${part.kind} out of the order of its sections`);

// What follows the header: each section, and each read model the header names, opened when its
// first record comes or at the end, and closed when the next one opens.
const documentWriter = (names: readonly string[]) => {
  let section = -1;
  let readModel = -1;
  const records = arrayWriter("  ");
  const rows = arrayWriter("    ");
  const toSection = (to: number): string => {
    let text = "";
    while (section < to) {
      if (section >= 0) text += records.close();
      section += 1;
      if (section < READ_MODELS) {
        text += `,\n  ${JSON.stringify(SECTIONS[section]?.[1])}: [`;
        records.open();
      } else text += `,\n  "readModels": {`;
    }
    return text;
  };
  const toReadModel = (to: number): string => {
    let text = toSection(READ_MODELS);
    while (readModel < to) {
      if (readModel >= 0) text += rows.close();
      readModel += 1;
      if (readModel < names.length) {
        text += `${readModel === 0 ? "" : ","}\n    ${JSON.stringify(names[readModel])}: [`;
        rows.open();
      }
    }
    return text;
  };
  return {
    record: (part: PersonalDataExportRecord): string => {
      if (part.kind === "row") {
        const to = names.indexOf(part.readModel);
        if (to === -1 || to < readModel) throw outOfOrder(part);
        return `${toReadModel(to)}${rows.item(part.row)}`;
      }
      const to = SECTIONS.findIndex(([kind]) => kind === part.kind);
      if (to < section) throw outOfOrder(part);
      return `${toSection(to)}${records.item(recordOf(part))}`;
    },
    end: (): string => `${toReadModel(names.length)}${names.length === 0 ? "}" : "\n  }"}\n}`,
  };
};

async function* jsonChunks(
  parts: AsyncIterable<PersonalDataExportPart>,
): AsyncGenerator<string, void, undefined> {
  let writer: ReturnType<typeof documentWriter> | undefined;
  for await (const part of parts) {
    if (part.kind === "header") {
      if (writer !== undefined) throw new Error("A personal data export has a second header");
      const { readModels, ...header } = part.header;
      writer = documentWriter(readModels);
      yield `{${Object.entries(header)
        .map(([key, value]) => `\n  ${JSON.stringify(key)}: ${indented(value, "  ")}`)
        .join(",")}`;
    } else {
      if (writer === undefined) {
        throw new Error(`A personal data export has a ${part.kind} before its header`);
      }
      yield writer.record(part);
    }
  }
  if (writer === undefined) throw new Error("A personal data export ended before its header");
  yield writer.end();
}

/**
 * The export as one JSON document, the same text `JSON.stringify` writes of what
 * `exportPersonalData` answers, two spaces deep, written as the parts come: a body for a response
 * or a file, whatever the person's history holds. A part is read only when the stream is, never
 * ahead of it, and cancelling the stream closes the parts. A part that rejects errors the stream, whose text then ends
 * where the document was cut: whoever reads it finds it is not valid JSON.
 */
export const personalDataExportJson: PersonalDataExportJsonFunction = (parts) => {
  const chunks = jsonChunks(parts);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        const next = await chunks.next();
        if (next.done === true) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
      cancel: async () => {
        await chunks.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
};
