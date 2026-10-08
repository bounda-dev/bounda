import type { registry } from "./registry.ts";
import type { PortsConfig, TestPorts } from "./types.ts";

declare module "@bounda-dev/core/register" {
  interface Register {
    readonly registry: typeof registry;
    readonly ports: PortsConfig;
    readonly testPorts: TestPorts;
  }
}
