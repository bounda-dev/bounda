import type { DeadLetter } from "@bounda-dev/core";

export interface FormatLetterFunction {
  (letter: DeadLetter): string;
}

const parkedEvents = (count: number): string =>
  `${count} event${count === 1 ? " is" : "s are"} parked`;

/**
 * A dead letter as `bounda dead-letters list` prints it: what failed, where, how often and why,
 * and the events parked behind a process failure.
 */
export const formatLetter: FormatLetterFunction = (letter) =>
  [
    `${letter.id}  ${letter.status}  ${letter.kind}  ${letter.subscriber}`,
    `    ${letter.eventType} on ${letter.aggregateType}:${letter.aggregateId}, ${letter.attempts} attempt${letter.attempts === 1 ? "" : "s"}, last ${letter.lastFailedAt} (${letter.errorType})`,
    `    ${letter.errorMessage}`,
    ...((letter.parked ?? 0) > 0
      ? [`    ${parkedEvents(letter.parked ?? 0)} behind it; replaying it handles them in order`]
      : []),
  ].join("\n");

/**
 * What `bounda dead-letters replay` prints for the letter a replay returns, saying when the
 * process failed again on one of the events parked behind it.
 */
export const formatReplayed: FormatLetterFunction = (letter) =>
  [
    `replayed dead letter ${letter.id}: ${letter.kind} ${letter.subscriber} for ${letter.eventType}`,
    ...((letter.parked ?? 0) > 0
      ? [
          `the process failed again on a parked event; ${parkedEvents(letter.parked ?? 0)} behind the new dead letter`,
        ]
      : []),
  ].join("\n");
