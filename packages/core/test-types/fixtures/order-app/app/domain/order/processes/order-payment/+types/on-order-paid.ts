import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../../.bounda/types.ts";

type ProcessModule = typeof import("../index.ts");
type HandlerModule = typeof import("../on-order-paid.ts");

export declare namespace Process {
  type ReturnCheck = core.ProcessHandlerReturnCheck<core.ProcessStateOf<ProcessModule>, HandlerModule>;
  type HandlerArgs = core.ProcessHandlerArgs<
    core.StoredEventOf<generated.OrderEvents, "orderPaid">,
    core.ProcessStateOf<ProcessModule>,
    generated.ReactionCommands,
    generated.OrderPorts
  >;
}
