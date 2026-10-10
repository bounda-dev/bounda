import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../.bounda/types.ts";

type Module = typeof import("../reminder-sent.ts");

export declare namespace Event {
  type PayloadArgs = core.PayloadArgs;
  type BeginArgs = core.EventBeginArgs<
    "ReminderSent",
    core.PayloadOf<Module>
  >;
  type EvolveArgs = core.EventEvolveArgs<
    generated.OrderCreatedState,
    "ReminderSent",
    core.PayloadOf<Module>
  >;
  type Upcasts = core.Upcasts<core.PayloadOf<Module>>;
}
