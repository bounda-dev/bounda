import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../../.bounda/types.ts";

type ProcessModule = typeof import("../index.ts");

export declare namespace Process {
  type DeadlineArgs = core.ProcessDeadlineArgs<
    core.ProcessStateOf<ProcessModule>,
    core.ProcessDeadlineField<ProcessModule, "nextReminder">,
    generated.Commands,
    import("../index.ts").Collaborators
  >;
}
