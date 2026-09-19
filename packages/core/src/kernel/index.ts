export type { BuildAggregatesArgs, BuildAggregatesFunction } from "./aggregate/build-aggregates.ts";
export { buildAggregates } from "./aggregate/build-aggregates.ts";
export type { FoldStateArgs, FoldStateFunction } from "./aggregate/fold-state.ts";
export { foldState } from "./aggregate/fold-state.ts";
export type {
  AggregateRuntime,
  AggregatesRuntime,
  CommandRuntime,
  EventRuntime,
} from "./aggregate/runtime.ts";
export type {
  CommandsFacadeRuntime,
  CreateCommandsFacadeArgs,
  CreateCommandsFacadeFunction,
} from "./command/facade.ts";
export { createCommandsFacade } from "./command/facade.ts";
export type {
  CommandPipeline,
  CreateCommandPipelineArgs,
  CreateCommandPipelineFunction,
  DispatchArgs,
} from "./command/pipeline.ts";
export { createCommandPipeline } from "./command/pipeline.ts";
export type { ValidatePayloadArgs, ValidatePayloadFunction } from "./command/validate.ts";
export { validatePayload } from "./command/validate.ts";
