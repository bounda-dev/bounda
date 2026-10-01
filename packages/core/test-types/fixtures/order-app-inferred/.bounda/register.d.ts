import type { registry } from "./registry.ts";
import type { CollaboratorsConfig, TestCollaborators } from "./types.ts";

declare module "@bounda-dev/core/register" {
  interface Register {
    readonly registry: typeof registry;
    readonly collaborators: CollaboratorsConfig;
    readonly testCollaborators: TestCollaborators;
  }
}
