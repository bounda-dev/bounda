import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../.bounda/types.ts";

type Module = typeof import("../order-paid.ts");

export declare namespace Event {
  type PayloadArgs = core.PayloadArgs;
  type ApplyArgs = core.EventApplyArgs<
    generated.OrderState,
    "OrderPaid",
    core.PayloadOf<Module>
  >;
}
