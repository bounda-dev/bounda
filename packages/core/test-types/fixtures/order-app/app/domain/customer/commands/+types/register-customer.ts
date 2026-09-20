import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../.bounda/types.ts";

type Module = typeof import("../register-customer.ts");

export declare namespace Command {
  type PayloadArgs = core.PayloadArgs;
  type HandlerArgs = core.CommandHandlerArgs<
    "RegisterCustomer",
    core.PayloadOf<Module>,
    generated.CustomerState,
    generated.CustomerEvents,
    core.EmptyPayload
  >;
}
