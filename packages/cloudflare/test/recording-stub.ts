import type { BoundaStub } from "../src/client.ts";

/**
 * A stand-in for a Bounda object's stub that records the arguments of every command, query and
 * operation on a person or a dead letter, and answers each call with an empty success.
 */
export const recordingStub = (): {
  readonly stub: BoundaStub;
  readonly commands: unknown[][];
  readonly queries: unknown[][];
  readonly forgets: unknown[][];
  readonly exports: unknown[][];
  readonly deadLetters: unknown[][];
} => {
  const commands: unknown[][] = [];
  const queries: unknown[][] = [];
  const forgets: unknown[][] = [];
  const exports: unknown[][] = [];
  const deadLetters: unknown[][] = [];
  const answer = async () => ({ ok: true, value: null });
  return {
    commands,
    queries,
    forgets,
    exports,
    deadLetters,
    stub: {
      command: async (...args) => {
        commands.push(args);
        return answer();
      },
      forget: async (...args) => {
        forgets.push(args);
        return answer();
      },
      query: async (...args) => {
        queries.push(args);
        return answer();
      },
      lag: answer,
      readEvents: answer,
      listDeadLetters: async (...args) => {
        deadLetters.push(["list", ...args]);
        return answer();
      },
      retryDeadLetter: async (...args) => {
        deadLetters.push(["retry", ...args]);
        return answer();
      },
      discardDeadLetter: async (...args) => {
        deadLetters.push(["discard", ...args]);
        return answer();
      },
      rebuildReadModel: answer,
      exportPersonalData: async (...args) => {
        exports.push(args);
        return answer();
      },
      restrict: async (...args) => {
        forgets.push(["restrict", ...args]);
        return answer();
      },
      unrestrict: async (...args) => {
        forgets.push(["unrestrict", ...args]);
        return answer();
      },
    },
  };
};
