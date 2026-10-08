import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../../.bounda/types.ts";

type ProcessModule = typeof import("../index.ts");
type HandlerModule = typeof import("../at-timeout.ts");

export declare namespace Process {
  type ReturnCheck = core.ProcessHandlerReturnCheck<core.ProcessStateOf<ProcessModule>, HandlerModule>;
  type DeadlineArgs = core.ProcessDeadlineArgs<
    core.ProcessStateOf<ProcessModule>,
    never,
    generated.ReactionCommands,
    generated.OrderPorts
  >;
}
