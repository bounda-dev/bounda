import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../../.bounda/types.ts";

export declare namespace Process {
  type ConfigArgs = core.ProcessConfigArgs<generated.Events>;
  type StateArgs = core.ProcessStateArgs;
  type CorrelateArgs = core.ProcessCorrelateArgs<generated.Events>;
}
