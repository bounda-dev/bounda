import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../../generated/types.ts";

type ProcessModule = typeof import("../index.ts");

export declare namespace Process {
  type HandlerArgs = core.ProcessHandlerArgs<
    core.StoredEventOf<generated.OrderEvents, "orderPaid">,
    core.ProcessStateOf<ProcessModule>,
    generated.Commands
  >;
}
