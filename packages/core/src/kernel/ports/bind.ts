import type { DisclosingRun, Disclosures } from "../recipients/gate.ts";
import { bindReturns, type PortReturns, type ReturnsRun } from "./returns.ts";

// Either is absent in an app that has none.
export interface PortWrappers {
  readonly disclosures?: Disclosures | undefined;
  readonly returns?: PortReturns | undefined;
}

export interface BindPortsFunction {
  (
    wrappers: PortWrappers,
    owner: string,
    ports: Readonly<Record<string, unknown>>,
    run: DisclosingRun & ReturnsRun,
  ): Readonly<Record<string, unknown>>;
}

// The gate records a disclosure before the call, so it goes inside what reads the answer after.
export const bindPorts: BindPortsFunction = ({ disclosures, returns }, owner, ports, run) => {
  const gated = disclosures?.bind(owner, ports, run) ?? ports;
  return returns === undefined ? gated : bindReturns(returns, owner, gated, run);
};
