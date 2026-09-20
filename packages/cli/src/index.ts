export type { DiscoverProjectArgs, DiscoverProjectFunction } from "./generate/discover.ts";
export { discoverProject } from "./generate/discover.ts";
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

export const packageName: string = "@bounda-dev/cli";
