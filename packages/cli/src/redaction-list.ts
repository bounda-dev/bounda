import type { RedactedFields } from "@bounda-dev/core";

export interface ParseRedactionListFunction {
  (text: string): readonly RedactedFields[];
}

const isName = (value: unknown): value is string => typeof value === "string" && value !== "";

const fieldOf = (value: object, name: string): unknown => Reflect.get(value, name);

// What fails names the line, never what it holds: a line may carry a person's value by mistake.
const targetOf = (line: string, number: number): RedactedFields => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`line ${number} is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`line ${number} is not an object`);
  }
  const [aggregateType, aggregateId, type, id] = ["aggregateType", "aggregateId", "type", "id"].map(
    (name) => fieldOf(parsed, name),
  );
  const fields = fieldOf(parsed, "fields");
  if (!isName(aggregateType) || !isName(aggregateId) || !isName(type) || !isName(id)) {
    throw new Error(`line ${number} needs the event's aggregateType, aggregateId, type and id`);
  }
  if (!Array.isArray(fields) || fields.length === 0 || !fields.every(isName)) {
    throw new Error(`line ${number} needs the fields to redact, as a list of names`);
  }
  return { aggregateType, aggregateId, type, id, fields };
};

/**
 * The events `bounda redact --from` reads, one a line, as JSON: each an event of the person's
 * export, by `aggregateType`, `aggregateId`, `type` and `id`, with the `fields` to redact. Blank
 * lines are skipped; throws an `Error` naming the first line that is not one.
 */
export const parseRedactionList: ParseRedactionListFunction = (text) =>
  text
    .split(/\r?\n/)
    .map((line, index) => [line.trim(), index + 1] as const)
    .filter(([line]) => line !== "")
    .map(([line, number]) => targetOf(line, number));
