import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../.bounda/types.ts";

type Module = typeof import("../order-placed.ts");

export declare namespace Event {
  type PayloadArgs = core.PayloadArgs;
  type ApplyArgs = core.EventApplyArgs<
    generated.OrderState,
    "OrderPlaced",
    core.PayloadOf<Module>
  >;
  type Upcasts = core.Upcasts<core.PayloadOf<Module>>;
}
