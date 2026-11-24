import type { BoundaStub } from "@bounda-dev/cloudflare";

// What the tests in Node load for `cloudflare:workers`: the Worker's bindings, which a test sets,
// and the base class `@bounda-dev/cloudflare` extends when it is imported.
export const env: Record<string, unknown> = {};

export class DurableObject {}

interface FakeNamespace {
  idFromName(name: string): string;
  get(id: string): BoundaStub;
}

export interface FakeStoreNamespace {
  readonly namespace: FakeNamespace & {
    jurisdiction(jurisdiction: string): FakeNamespace;
  };
  /**
   * Every call a store received, after the name of its tenant, written `<jurisdiction>/<name>`
   * for an object reached in a jurisdiction.
   */
  readonly calls: unknown[][];
}

/**
 * A stand-in for a Bounda Durable Object's namespace whose stubs record their calls and answer
 * each with an empty success: a stream with no part for `streamPersonalData` and `exportTenant`.
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
      status: record("status"),
      listSubscriberFailures: record("listSubscriberFailures"),
      getSubscriberFailure: record("getSubscriberFailure"),
      readEvents: record("readEvents"),
      listDeadLetters: record("listDeadLetters"),
      retryDeadLetter: record("retryDeadLetter"),
      discardDeadLetter: record("discardDeadLetter"),
      rebuildReadModel: record("rebuildReadModel"),
      forget: record("forget"),
      exportPersonalData: record("exportPersonalData"),
      streamPersonalData: async (...args: unknown[]) => {
        calls.push([tenant, "streamPersonalData", ...args]);
        return { ok: true, value: new Blob([]).stream() };
      },
      recipientsOf: record("recipientsOf"),
      restrict: record("restrict"),
      unrestrict: record("unrestrict"),
      redact: record("redact"),
      forgetTenant: record("forgetTenant"),
      exportTenant: async (...args: unknown[]) => {
        calls.push([tenant, "exportTenant", ...args]);
        return { ok: true, value: new Blob([]).stream() };
      },
      freezeTenant: record("freezeTenant"),
      unfreezeTenant: record("unfreezeTenant"),
      rotateTenantKey: record("rotateTenantKey"),
      retireTenantKeys: record("retireTenantKeys"),
    };
  };
  return {
    calls,
    namespace: {
      idFromName: (name) => name,
      get: stubOf,
      jurisdiction: (jurisdiction) => ({
        idFromName: (name) => `${jurisdiction}/${name}`,
        get: stubOf,
      }),
    },
  };
};
