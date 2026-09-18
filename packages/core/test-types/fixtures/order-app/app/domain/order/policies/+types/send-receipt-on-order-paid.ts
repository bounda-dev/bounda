import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../generated/types.ts";

export declare namespace Policy {
  type HandlerArgs = core.PolicyHandlerArgs<
    core.StoredEventOf<generated.OrderEvents, "orderPaid">,
    generated.Commands
  >;
}
