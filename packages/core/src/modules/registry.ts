import type { DispatchOptions, DispatchResult } from "../contracts/command.ts";
import type { StateModule } from "./aggregate.ts";
import type { CommandEntry, CommandModule } from "./command.ts";
import type { EventModules } from "./event.ts";
import type { Simplify, UnionToIntersection } from "./naming.ts";
import type { HasPayload, PayloadOf } from "./payload.ts";
import type { PolicyModule } from "./policy.ts";
import type { ProcessEntry } from "./process.ts";
import type { ProjectionModule } from "./projection.ts";
import type { QueryModule, QueryResultOf } from "./query.ts";
import type { ViewModule } from "./view.ts";

/**
 * One aggregate in the registry: its optional state module and everything found under its folder.
 */
export interface AggregateEntry {
  readonly state?: StateModule;
  readonly events: EventModules;
  readonly commands: Readonly<Record<string, CommandEntry>>;
  readonly policies: Readonly<Record<string, PolicyModule>>;
  readonly processes: Readonly<Record<string, ProcessEntry>>;
}

/**
 * One read model in the registry.
 */
export interface ReadModelEntry {
  readonly view: ViewModule;
  readonly projections: Readonly<Record<string, ProjectionModule>>;
  readonly queries: Readonly<Record<string, QueryModule>>;
}

/**
 * The registry the generator writes to `.bounda/registry.ts`: every module of the app, grouped by
 * folder. `createApp` takes it as the single description of the domain.
 */
export interface Registry {
  readonly aggregates: Readonly<Record<string, AggregateEntry>>;
  readonly readModels: Readonly<Record<string, ReadModelEntry>>;
}

/**
 * The function `app.commands.<name>` exposes for one command.
 */
export type CommandInvoker<Module> =
  HasPayload<Module> extends true
    ? (payload: PayloadOf<Module>, options?: DispatchOptions) => Promise<DispatchResult>
    : (options?: DispatchOptions) => Promise<DispatchResult>;

/**
 * `app.commands` typed from a map of command modules. The generator emits this map with
 * `typeof import(...)` entries so `+types` files never depend on the registry value.
 */
export type CommandsFacadeOf<Modules extends Readonly<Record<string, CommandModule>>> = {
  readonly [Name in keyof Modules]: CommandInvoker<Modules[Name]>;
};

type CommandModulesOf<Aggregate extends AggregateEntry> = {
  readonly [Name in keyof Aggregate["commands"]]: Aggregate["commands"][Name]["module"];
};

/**
 * `app.commands`: every command of every aggregate, typed from the registry.
 */
export type CommandsFacade<R extends Registry> = Simplify<
  UnionToIntersection<
    {
      [Name in keyof R["aggregates"]]: CommandsFacadeOf<CommandModulesOf<R["aggregates"][Name]>>;
    }[keyof R["aggregates"]]
  >
>;

/**
 * The function `app.queries.<name>` exposes for one query.
 */
export type QueryInvoker<Module> =
  HasPayload<Module> extends true
    ? (payload: PayloadOf<Module>) => Promise<QueryResultOf<Module>>
    : () => Promise<QueryResultOf<Module>>;

/**
 * `app.queries` typed from a map of query modules.
 */
export type QueriesFacadeOf<Modules extends Readonly<Record<string, QueryModule>>> = {
  readonly [Name in keyof Modules]: QueryInvoker<Modules[Name]>;
};

/**
 * `app.queries`: every query of every read model, typed from the registry.
 */
export type QueriesFacade<R extends Registry> = Simplify<
  UnionToIntersection<
    {
      [Name in keyof R["readModels"]]: QueriesFacadeOf<R["readModels"][Name]["queries"]>;
    }[keyof R["readModels"]]
  >
>;
