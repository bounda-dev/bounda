import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../.bounda/types.ts";

type Module = typeof import("../place-order.ts");

export declare namespace Command {
  type PayloadArgs = core.PayloadArgs;
  type RejectionsArgs = core.CommandRejectionsArgs<
    "PlaceOrder",
    core.PayloadOf<Module>,
    generated.OrderState
  >;
  type HandlerArgs = core.CommandHandlerArgs<
    "PlaceOrder",
    core.PayloadOf<Module>,
    generated.OrderState,
    generated.OrderEvents,
    generated.OrderPorts,
    core.RejectionCodeOf<Module>
  >;
}
