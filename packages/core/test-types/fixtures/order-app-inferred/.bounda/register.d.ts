import type { registry } from "./registry.ts";

declare module "@bounda-dev/core/register" {
  interface Register {
    readonly registry: typeof registry;
  }
}
