import type { BoundaStub } from "../src/client.ts";

/**
 * A stand-in for a Bounda object's stub that records the arguments of every command and answers
 * each call with an empty success.
 */
export const recordingStub = (): {
  readonly stub: BoundaStub;
  readonly commands: unknown[][];
  readonly forgets: unknown[][];
  readonly exports: unknown[][];
} => {
  const commands: unknown[][] = [];
  const forgets: unknown[][] = [];
  const exports: unknown[][] = [];
  const answer = async () => ({ ok: true, value: null });
  return {
    commands,
    forgets,
    exports,
    stub: {
      command: async (...args) => {
        commands.push(args);
        return answer();
      },
      forget: async (...args) => {
        forgets.push(args);
        return answer();
      },
      query: answer,
      lag: answer,
      readEvents: answer,
      listDeadLetters: answer,
      retryDeadLetter: answer,
      discardDeadLetter: answer,
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
