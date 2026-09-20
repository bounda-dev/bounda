export type { DiscoverProjectArgs, DiscoverProjectFunction } from "./generate/discover.ts";
export { discoverProject } from "./generate/discover.ts";
export type {
  EmitPlusTypesArgs,
  EmitPlusTypesFunction,
  EmitProjectArgs,
  EmitProjectFunction,
  EmitRegistryArgs,
  EmitRegistryFunction,
  EmitTypesArgs,
  EmitTypesFunction,
  GeneratedFile,
  StateTypeSource,
} from "./generate/emit/index.ts";
export {
  emitPlusTypes,
  emitProject,
  emitRegistry,
  emitTypes,
  GENERATED_DIRECTORY,
  importPath,
  plusTypesPath,
} from "./generate/emit/index.ts";
export type { GenerateArgs, GenerateFunction, GenerateReport } from "./generate/generate.ts";
export { generate } from "./generate/generate.ts";
export type {
  AggregateModel,
  CollaboratorModel,
  CommandModel,
  EventModel,
  ModuleRef,
  PolicyModel,
  ProcessHandlerModel,
  ProcessModel,
  ProjectionModel,
  ProjectModel,
  QueryModel,
  ReadModelModel,
} from "./generate/model.ts";
export type { Problem } from "./generate/problems.ts";
export { ConventionError } from "./generate/problems.ts";

export type {
  InferStatesArgs,
  InferStatesFunction,
  InferStatesResult,
  StateWarning,
} from "./generate/state/infer.ts";
export { inferStates } from "./generate/state/infer.ts";
export type { WatchProjectArgs, WatchProjectFunction } from "./generate/watch.ts";
export { watchProject } from "./generate/watch.ts";
export type {
  RemoveOrphansArgs,
  RemoveOrphansFunction,
  WriteGeneratedFileFunction,
  WriteGeneratedFilesFunction,
  WriteReport,
} from "./generate/write.ts";
export { removeOrphans, writeGeneratedFile, writeGeneratedFiles } from "./generate/write.ts";
export type {
  FormatConventionErrorArgs,
  FormatConventionErrorFunction,
  FormatReportArgs,
  FormatReportFunction,
  FormatWarningsFunction,
} from "./reporter.ts";
export { formatConventionError, formatReport, formatWarnings } from "./reporter.ts";
export type { Output, RunCliArgs, RunCliFunction } from "./run.ts";
export { EXIT_CONVENTION, EXIT_FAILURE, EXIT_OK, runCli } from "./run.ts";
