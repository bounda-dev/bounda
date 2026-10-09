import type { TenantFunction } from "@bounda-dev/react-router/cloudflare";

// The store each request reaches: one Durable Object per tenant, with its own events and read
// models. Every request reaching the same one is a choice, right for an app with a single team; to
// keep each customer's data apart, name theirs, from the URL (`params`) or the signed-in user.
export const tenant: TenantFunction = () => "default";
