import type { BoundaStub } from "@bounda-dev/cloudflare";

// What the tests in Node load for `cloudflare:workers`: the Worker's bindings, which a test sets,
// and the base class `@bounda-dev/cloudflare` extends when it is imported.
export const env: Record<string, unknown> = {};

export class DurableObject {}

export interface FakeStoreNamespace {
  readonly namespace: {
    idFromName(name: string): string;
    get(id: string): BoundaStub;
  };
  /**
   * Every call a store received, after the name of its tenant.
   */
  readonly calls: unknown[][];
}

/**
 * A stand-in for a Bounda Durable Object's namespace whose stubs record their calls and answer
 * each with an empty success.
 */
export const storeNamespace = (): FakeStoreNamespace => {
  const calls: unknown[][] = [];
  const stubOf = (tenant: string): BoundaStub => {
    const record =
      (method: string) =>
      async (...args: unknown[]) => {
        calls.push([tenant, method, ...args]);
        return { ok: true, value: null };
      };
    return {
      command: record("command"),
      query: record("query"),
      lag: record("lag"),
      listDeadLetters: record("listDeadLetters"),
      retryDeadLetter: record("retryDeadLetter"),
      discardDeadLetter: record("discardDeadLetter"),
      rebuildReadModel: record("rebuildReadModel"),
    };
  };
  return { calls, namespace: { idFromName: (name) => name, get: stubOf } };
};
