import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../../.bounda/types.ts";

type ProcessModule = typeof import("../index.ts");
type HandlerModule = typeof import("../at-next-reminder.ts");

export declare namespace Process {
  type ReturnCheck = core.ProcessHandlerReturnCheck<core.ProcessStateOf<ProcessModule>, HandlerModule>;
  type DeadlineArgs = core.ProcessDeadlineArgs<
    core.ProcessStateOf<ProcessModule>,
    core.ProcessDeadlineField<ProcessModule, "nextReminder">,
    generated.Commands,
    import("../index.ts").Collaborators
  >;
}
