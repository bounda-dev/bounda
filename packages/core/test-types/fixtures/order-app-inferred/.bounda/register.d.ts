import type { registry } from "./registry.ts";
import type { CollaboratorsConfig } from "./types.ts";

declare module "@bounda-dev/core/register" {
  interface Register {
    readonly registry: typeof registry;
    readonly collaborators: CollaboratorsConfig;
  }
}
