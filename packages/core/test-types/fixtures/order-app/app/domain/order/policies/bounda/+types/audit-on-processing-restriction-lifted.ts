import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../../.bounda/types.ts";

export declare namespace Policy {
  type HandlerArgs = core.PolicyHandlerArgs<
    core.ProcessingRestrictionLiftedEvent,
    generated.ReactionCommands,
    generated.OrderPorts
  >;
}
