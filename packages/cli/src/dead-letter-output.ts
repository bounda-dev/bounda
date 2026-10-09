import type { DeadLetter } from "@bounda-dev/core";

export interface FormatLetterFunction {
  (letter: DeadLetter): string;
}

const parkedEvents = (count: number): string =>
  `${count} event${count === 1 ? " is" : "s are"} parked`;

/**
 * A dead letter as `bounda dead-letters list` prints it.
 */
export const formatLetter: FormatLetterFunction = (letter) =>
  [
    `${letter.id}  ${letter.status}  ${letter.kind}  ${letter.handler}`,
    `    ${letter.eventType} on ${letter.aggregateType}:${letter.aggregateId}, ${letter.attempts} attempt${letter.attempts === 1 ? "" : "s"}, last ${letter.lastFailedAt} (${letter.errorType})`,
    `    ${letter.errorMessage}`,
    ...((letter.parked ?? 0) > 0
      ? [
          // How core names the letter of a process's timeout, pinned by core's own tests.
          letter.eventId === "deadline:timeout"
            ? `    ${parkedEvents(letter.parked ?? 0)} behind it; retrying it times the process out and drops them`
            : `    ${parkedEvents(letter.parked ?? 0)} behind it; retrying it handles them in order`,
        ]
      : []),
  ].join("\n");

/**
 * What `bounda dead-letters retry` prints for the letter a retry returns, saying when the
 * process failed again while handling what waited behind it.
 */
export const formatRetried: FormatLetterFunction = (letter) =>
  [
    `retried dead letter ${letter.id}: ${letter.kind} ${letter.handler} for ${letter.eventType}`,
    ...((letter.parked ?? 0) > 0
      ? [
          `the process failed again; ${letter.parked} step${letter.parked === 1 ? " still waits" : "s still wait"}, starting with the new dead letter`,
        ]
      : []),
  ].join("\n");
