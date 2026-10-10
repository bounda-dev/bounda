import type { BoundaStub } from "../src/client.ts";

/**
 * A stand-in for a Bounda object's stub that records the arguments of every command and answers
 * each call with an empty success.
 */
export const recordingStub = (): { readonly stub: BoundaStub; readonly commands: unknown[][] } => {
  const commands: unknown[][] = [];
  const answer = async () => ({ ok: true, value: null });
  return {
    commands,
    stub: {
      command: async (...args) => {
        commands.push(args);
        return answer();
      },
      query: answer,
      lag: answer,
      listDeadLetters: answer,
      retryDeadLetter: answer,
      discardDeadLetter: answer,
      rebuildReadModel: answer,
    },
  };
};
