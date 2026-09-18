import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../generated/types.ts";

type Module = typeof import("../customer-registered.ts");

export declare namespace Event {
  type PayloadArgs = core.PayloadArgs;
  type ApplyArgs = core.EventApplyArgs<
    generated.CustomerState,
    "CustomerRegistered",
    core.PayloadOf<Module>
  >;
}
