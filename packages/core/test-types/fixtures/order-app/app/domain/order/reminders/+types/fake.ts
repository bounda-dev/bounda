import type * as core from "@bounda-dev/core";

type Port = import("../index.ts").Reminders;

export declare namespace Implementation {
  type Contract = Port;
  type CreateArgs = core.CreateArgs;
  type Create = core.CreateImplementation<Port>;
}
