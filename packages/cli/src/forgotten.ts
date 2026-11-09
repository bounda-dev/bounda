import {
  BOUNDA_AGGREGATE,
  type ForgetAgainEntry,
  type GlobalStream,
  PERSONAL_DATA_FORGOTTEN_EVENT,
  type PersonalDataForgottenPayload,
} from "@bounda-dev/core";
import { InvalidArgumentError } from "commander";

const PAGE = 1_000;
const POSITION = /^\d+$/;
// A date, and a time after it if any, as ISO 8601 writes them; `Date.parse` alone takes "-3".
const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]|$)/;

/**
 * Where `--since` starts: after a position of the global stream, or at a time.
 */
export interface Since {
  readonly kind: "position" | "date";
  /**
   * The position, or the time in milliseconds.
   */
  readonly value: number;
}

export interface ParseSinceFunction {
  (value: string): Since;
}

export const parseSince: ParseSinceFunction = (value) => {
  const text = value.trim();
  if (POSITION.test(text)) return { kind: "position", value: Number(text) };
  const at = Date.parse(text);
  if (!DATE.test(text) || Number.isNaN(at)) {
    throw new InvalidArgumentError(
      "expected a position of the stream, a whole number, or a date such as 2026-11-01",
    );
  }
  return { kind: "date", value: at };
};

/**
 * One forgetting, as a line of what `bounda forgotten` prints and `bounda forget --from` reads:
 * the entry a forget ledger keeps.
 */
export interface ForgottenLine {
  readonly personId: string;
  readonly eventId: string;
  readonly forgottenAt: string;
  /**
   * The categories the forgetting asked for, `null` for the person as a whole.
   */
  readonly categories: readonly string[] | null;
}

export interface ReadForgottenArgs {
  readonly events: GlobalStream;
  readonly since: Since;
}

export interface ReadForgottenFunction {
  (args: ReadForgottenArgs): Promise<readonly ForgottenLine[]>;
}

/**
 * Reads the stream from `since` on and keeps the `PersonalDataForgotten` of the persons' streams.
 * A date is compared with each event's time, so the whole stream is read for it.
 */
export const readForgotten: ReadForgottenFunction = async ({ events, since }) => {
  const lines: ForgottenLine[] = [];
  for (let after = since.kind === "position" ? since.value : 0; ; ) {
    const page = await events.read({ after, limit: PAGE });
    for (const event of page) {
      if (event.aggregateType !== BOUNDA_AGGREGATE) continue;
      if (event.type !== PERSONAL_DATA_FORGOTTEN_EVENT) continue;
      if (since.kind === "date" && Date.parse(event.timestamp) < since.value) continue;
      const payload = event.payload as PersonalDataForgottenPayload;
      lines.push({
        personId: event.aggregateId,
        eventId: event.id,
        forgottenAt: event.timestamp,
        categories: payload.whole === false ? [...payload.categories, ...payload.retained] : null,
      });
    }
    const last = page.at(-1);
    if (last === undefined || page.length < PAGE) return lines;
    after = last.position;
  }
};

const entryOf = (line: string, number: number): ForgetAgainEntry => {
  if (!line.startsWith("{")) return { personId: line };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`line ${number} is neither a person's id nor JSON`);
  }
  const personId: unknown = Reflect.get(parsed as object, "personId");
  const eventId: unknown = Reflect.get(parsed as object, "eventId");
  const categories: unknown = Reflect.get(parsed as object, "categories");
  if (typeof personId !== "string" || (eventId !== undefined && typeof eventId !== "string")) {
    throw new Error(`line ${number} needs a "personId" string, and "eventId" only as a string`);
  }
  if (
    categories !== undefined &&
    categories !== null &&
    !(Array.isArray(categories) && categories.every((category) => typeof category === "string"))
  ) {
    throw new Error(`line ${number} has "categories" that is neither null nor a list of names`);
  }
  return {
    personId,
    ...(eventId === undefined ? {} : { eventId }),
    ...(categories === undefined ? {} : { categories: categories as readonly string[] | null }),
  };
};

export interface ParseForgetListFunction {
  (text: string): readonly ForgetAgainEntry[];
}

/**
 * Each line is what `bounda forgotten` prints, or a bare person's id; blank lines are skipped.
 */
export const parseForgetList: ParseForgetListFunction = (text) =>
  text
    .split(/\r?\n/)
    .map((line, index) => [line.trim(), index + 1] as const)
    .filter(([line]) => line !== "")
    .map(([line, number]) => entryOf(line, number));
