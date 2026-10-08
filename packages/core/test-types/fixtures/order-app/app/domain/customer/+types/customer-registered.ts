import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../.bounda/types.ts";

type Module = typeof import("../customer-registered.ts");

export declare namespace Event {
  type PayloadArgs = core.PayloadArgs;
  type CreateArgs = core.EventCreateArgs<
    "CustomerRegistered",
    core.PayloadOf<Module>
  >;
  type ApplyArgs = core.EventApplyArgs<
    generated.CustomerCreatedState,
    "CustomerRegistered",
    core.PayloadOf<Module>
  >;
  type Upcasts = core.Upcasts<core.PayloadOf<Module>>;
}
