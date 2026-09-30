import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../../../.bounda/types.ts";

type ProcessModule = typeof import("../../index.ts");
type HandlerModule = typeof import("../on-customer-registered.ts");

export declare namespace Process {
  type ReturnCheck = core.ProcessHandlerReturnCheck<core.ProcessStateOf<ProcessModule>, HandlerModule>;
  type HandlerArgs = core.ProcessHandlerArgs<
    core.StoredEventOf<generated.CustomerEvents, "customerRegistered">,
    core.ProcessStateOf<ProcessModule>,
    generated.ReactionCommands,
    import("../../index.ts").Collaborators
  >;
}
