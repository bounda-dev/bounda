import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../../generated/types.ts";

type Module = typeof import("../index.ts");

export declare namespace Command {
  type PayloadArgs = core.PayloadArgs;
  type HandlerArgs = core.CommandHandlerArgs<
    "CancelOrder",
    core.PayloadOf<Module>,
    generated.OrderState,
    generated.OrderEvents,
    generated.CancelOrderCollaborators
  >;
}
