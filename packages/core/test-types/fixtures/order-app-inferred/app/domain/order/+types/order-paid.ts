import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../.bounda/types.ts";

type Module = typeof import("../order-paid.ts");

export declare namespace Event {
  type PayloadArgs = core.EventPayloadArgs;
  type BeginArgs = core.EventBeginArgs<
    "OrderPaid",
    core.PayloadOf<Module>
  >;
  type EvolveArgs = core.EventEvolveArgs<
    generated.OrderCreatedState,
    "OrderPaid",
    core.PayloadOf<Module>
  >;
  type Upcasts = core.Upcasts<core.PayloadOf<Module>>;
}
