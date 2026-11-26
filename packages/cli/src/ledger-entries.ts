import {
  type AppliedAgain,
  PERSONAL_DATA_FORGOTTEN_REASONS,
  PROCESSING_RESTRICTED_EVENT,
  PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT,
  PROCESSING_RESTRICTION_LIFTED_EVENT,
  RESTRICTION_GROUNDS,
} from "@bounda-dev/core";
import type {
  ForgetLedgerEntry,
  LedgerDisclosure,
  LedgerRedaction,
  LedgerRestriction,
} from "@bounda-dev/core/adapter";

export interface ParseLedgerEntriesFunction {
  (text: string): readonly ForgetLedgerEntry[];
}

const fieldOf = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isName = (value: unknown): value is string => typeof value === "string" && value !== "";

const isNames = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isName);

const isCategories = (value: unknown): value is readonly string[] | null =>
  value === null || isNames(value);

const isTime = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const isGround = (value: unknown): boolean =>
  RESTRICTION_GROUNDS.includes(value as (typeof RESTRICTION_GROUNDS)[number]);

const isRestrictions = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (each) =>
      isGround(fieldOf(each, "ground")) &&
      isCategories(fieldOf(each, "categories")) &&
      isTime(fieldOf(each, "since")),
  );

// What restrictAgain reads of each kind of change, the person it names being the entry's.
const isRestriction = (value: unknown, personId: string): value is LedgerRestriction => {
  const type = fieldOf(value, "type");
  const payload = fieldOf(value, "payload");
  if (!isObject(payload) || fieldOf(payload, "personId") !== personId) return false;
  const categories = isCategories(fieldOf(payload, "categories"));
  if (type === PROCESSING_RESTRICTED_EVENT) {
    return (
      isGround(fieldOf(payload, "ground")) &&
      categories &&
      isRestrictions(fieldOf(payload, "restrictions"))
    );
  }
  const grounds = fieldOf(payload, "grounds");
  const named = Array.isArray(grounds) && grounds.length > 0 && grounds.every(isGround);
  if (type === PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT) {
    return named && categories && isTime(fieldOf(payload, "liftsAt"));
  }
  return (
    type === PROCESSING_RESTRICTION_LIFTED_EVENT &&
    named &&
    categories &&
    isRestrictions(fieldOf(payload, "restrictions"))
  );
};

const isRedaction = (value: unknown): value is LedgerRedaction => {
  const events = fieldOf(value, "events");
  return (
    Array.isArray(events) &&
    events.length > 0 &&
    events.every(
      (event) =>
        ["id", "aggregateType", "aggregateId", "type"].every((name) =>
          isName(fieldOf(event, name)),
        ) && isNames(fieldOf(event, "fields")),
    )
  );
};

const isDisclosure = (value: unknown): value is LedgerDisclosure => {
  const safeguard = fieldOf(value, "safeguard");
  return (
    ["port", "recipient", "kind", "country", "category"].every((name) =>
      isName(fieldOf(value, name)),
    ) &&
    (safeguard === null || isName(safeguard))
  );
};

const isReached = (value: unknown): boolean =>
  ["position", "generation"].every((name) => Number.isSafeInteger(fieldOf(value, name)));

// What fails names the line, never what it holds.
const entryOf = (line: string, number: number): ForgetLedgerEntry => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`line ${number} is not JSON`);
  }
  const personId = fieldOf(parsed, "personId");
  const eventId = fieldOf(parsed, "eventId");
  const forgottenAt = fieldOf(parsed, "forgottenAt");
  const reason = fieldOf(parsed, "reason");
  const categories = fieldOf(parsed, "categories");
  const fingerprints = fieldOf(parsed, "fingerprints");
  const committed = fieldOf(parsed, "committed");
  const reached = fieldOf(parsed, "reached");
  if (
    !isObject(parsed) ||
    !isName(personId) ||
    !isName(eventId) ||
    !isTime(forgottenAt) ||
    !PERSONAL_DATA_FORGOTTEN_REASONS.includes(reason as ForgetLedgerEntry["reason"]) ||
    !isCategories(categories) ||
    (fingerprints !== undefined && !isNames(fingerprints)) ||
    (committed !== undefined && committed !== false) ||
    (reached !== undefined && !isReached(reached))
  ) {
    throw new Error(
      `line ${number} is not a forget ledger's entry: it needs "personId", "eventId", "forgottenAt" as a time, "reason" and "categories", with "fingerprints" only as a list of strings, "committed" only as false and "reached" only as a position and a generation`,
    );
  }
  const kinds = ["restriction", "redaction", "disclosure"].filter(
    (name) => fieldOf(parsed, name) !== undefined,
  );
  const restriction = fieldOf(parsed, "restriction");
  const redaction = fieldOf(parsed, "redaction");
  const disclosure = fieldOf(parsed, "disclosure");
  if (
    kinds.length > 1 ||
    (restriction !== undefined && !isRestriction(restriction, personId)) ||
    (redaction !== undefined && !isRedaction(redaction)) ||
    (disclosure !== undefined && !isDisclosure(disclosure))
  ) {
    throw new Error(
      `line ${number} records at most one of a "restriction", a "redaction" and a "disclosure", each as a forget ledger keeps it`,
    );
  }
  return {
    personId,
    eventId,
    forgottenAt,
    reason: reason as ForgetLedgerEntry["reason"],
    categories,
    ...(fingerprints === undefined ? {} : { fingerprints }),
    ...(restriction === undefined ? {} : { restriction }),
    ...(redaction === undefined ? {} : { redaction }),
    ...(disclosure === undefined ? {} : { disclosure }),
    ...(committed === undefined ? {} : { committed: false as const }),
    ...(reached === undefined
      ? {}
      : { reached: reached as NonNullable<ForgetLedgerEntry["reached"]> }),
  };
};

/**
 * The entries `bounda forget-ledger apply --from` reads, one a line, as JSON: each as
 * `bounda forget-ledger stranded` prints it, the entry a forget ledger keeps. Blank lines are
 * skipped; throws an `Error` naming the first line that is not one.
 */
export const parseLedgerEntries: ParseLedgerEntriesFunction = (text) =>
  text
    .split(/\r?\n/)
    .map((line, index) => [line.trim(), index + 1] as const)
    .filter(([line]) => line !== "")
    .map(([line, number]) => entryOf(line, number));

export interface FormatAppliedFunction {
  (applied: AppliedAgain): string;
}

const OUTCOMES: Readonly<Record<AppliedAgain["outcome"], string>> = {
  applied: "applied again",
  held: "held already",
  reconciled: "left to the reconciliation, which reads it in the ledger",
  inapplicable: "refused, nothing of it applies to the database as it stands",
};

/**
 * One line per entry: what it was, of whom, and what applying it again did.
 */
export const formatApplied: FormatAppliedFunction = ({ kind, eventId, personId, outcome }) =>
  `${OUTCOMES[outcome]}: the ${kind} ${eventId} of ${personId}`;
