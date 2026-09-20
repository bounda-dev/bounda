import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../../.bounda/types.ts";

type ProcessModule = typeof import("../index.ts");

export declare namespace Process {
  type TimeoutArgs = core.ProcessTimeoutArgs<
    core.ProcessStateOf<ProcessModule>,
    generated.Commands
  >;
}
