import { ConfigurationError } from "@bounda-dev/core";

// What workerd throws from `jurisdiction()` where it runs locally, under `wrangler dev`, `vite dev`
// and the tests: it keeps every object on the machine, in no jurisdiction.
const UNSUPPORTED = /Jurisdiction restrictions are not implemented/;

const unsupported = (error: unknown): boolean =>
  error instanceof Error && UNSUPPORTED.test(error.message);

export interface NamespaceInFunction {
  <T extends Rpc.DurableObjectBranded | undefined>(
    namespace: DurableObjectNamespace<T>,
    jurisdiction: DurableObjectJurisdiction | undefined,
  ): DurableObjectNamespace<T>;
}

// The namespace whose ids are all in the jurisdiction, or the namespace itself without one or
// where the runtime has none.
export const namespaceIn: NamespaceInFunction = (namespace, jurisdiction) => {
  if (jurisdiction === undefined) return namespace;
  try {
    return namespace.jurisdiction(jurisdiction);
  } catch (error) {
    if (unsupported(error)) return namespace;
    throw error;
  }
};

export interface CheckObjectJurisdictionArgs {
  readonly id: DurableObjectId;
  readonly jurisdiction: DurableObjectJurisdiction | undefined;
  // A namespace of the Worker, when its `env` has the binding: what tells a runtime without
  // jurisdictions.
  readonly namespace: DurableObjectNamespace | undefined;
  // What the object is, for the refusal: a tenant's, or the keeper of tenants' keys and ledgers.
  readonly kind?: "tenant" | "keeper";
}

export interface CheckObjectJurisdictionFunction {
  (args: CheckObjectJurisdictionArgs): void;
}

const named = (jurisdiction: string | undefined): string =>
  jurisdiction === undefined ? "no jurisdiction" : `jurisdiction ${jurisdiction}`;

// One tenant reached through two jurisdictions is two objects, its data split between them: an
// object refuses to start outside the jurisdiction the configuration names.
export const checkObjectJurisdiction: CheckObjectJurisdictionFunction = ({
  id,
  jurisdiction,
  namespace,
  kind = "tenant",
}) => {
  const actual = id.jurisdiction;
  if (actual === jurisdiction) return;
  if (
    actual === undefined &&
    namespace !== undefined &&
    namespaceIn(namespace, jurisdiction) === namespace
  ) {
    return;
  }
  throw new ConfigurationError(
    kind === "tenant"
      ? `This Durable Object was created in ${named(actual)}, and cloudflare() names ${named(jurisdiction)}: a tenant reached in two jurisdictions is two objects, each with part of its data. Reach the objects through tenantStub(), or through the namespace's jurisdiction() as cloudflare() names it`
      : `This keeper Durable Object was created in ${named(actual)}, and cloudflare() names ${named(jurisdiction)}: the keys and ledger entries it holds never leave where it was created. Reach it through durableObjectTenantKeys() and durableObjectForgetLedger() alone`,
  );
};
