import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../../generated/types.ts";

export declare namespace Process {
  type ConfigArgs = core.ProcessConfigArgs<core.EventTypeNames<generated.OrderEvents>>;
  type StateArgs = core.ProcessStateArgs;
}
