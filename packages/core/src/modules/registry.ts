import type {
  DispatchOptions,
  DispatchResult,
  ReactionDispatchResult,
} from "../contracts/command.ts";
import type { StateModule } from "./aggregate.ts";
import type { CollaboratorModules } from "./collaborator.ts";
import type { CommandEntry, CommandModule, RejectionCodeOf } from "./command.ts";
import type { EventModules } from "./event.ts";
import type { Simplify, UnionToIntersection } from "./naming.ts";
import type { HasPayload, PayloadInputOf } from "./payload.ts";
import type { PolicyEntry } from "./policy.ts";
import type { ProcessEntry } from "./process.ts";
import type { ProjectionModule } from "./projection.ts";
import type { QueryModule, QueryResultOf } from "./query.ts";
import type { UpcastsModule } from "./upcast.ts";
import type { ViewModule } from "./view.ts";

/**
 * One aggregate in the registry: its optional state module and everything found under its folder.
 */
export interface AggregateEntry {
  readonly state?: StateModule;
  readonly events: EventModules;
  /**
   * The `<event>.upcast.ts` modules found next to the events, keyed like `events`. Only events
   * whose payload has changed shape have one.
   */
  readonly upcasts?: Readonly<Record<string, UpcastsModule>>;
  /**
   * The implementations of every port of the aggregate (`<port>/<name>.ts`), which every handler
   * of its commands, policies and processes receives once the configuration has chosen one.
   */
  readonly collaborators?: CollaboratorModules;
  readonly commands: Readonly<Record<string, CommandEntry>>;
  readonly policies: Readonly<Record<string, PolicyEntry>>;
  readonly processes: Readonly<Record<string, ProcessEntry>>;
}

/**
 * One read model in the registry. Projections are grouped by the aggregate whose events they
 * project, then keyed by event: `projections.order.orderPlaced`.
 */
export interface ReadModelEntry {
  readonly view: ViewModule;
  readonly projections: Readonly<Record<string, Readonly<Record<string, ProjectionModule>>>>;
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
    ? (payload: PayloadInputOf<Module>, options?: DispatchOptions) => Promise<DispatchResult>
    : "payload" extends keyof Module
      ? (payload?: unknown, options?: DispatchOptions) => Promise<DispatchResult>
      : (options?: DispatchOptions) => Promise<DispatchResult>;

/**
 * `app.commands` typed from a map of command modules.
 */
export type CommandsFacadeOf<Modules extends Readonly<Record<string, CommandModule>>> = {
  readonly [Name in keyof Modules]: CommandInvoker<Modules[Name]>;
};

/**
 * The function a policy or process handler's `commands.<name>` exposes for one command: as
 * `CommandInvoker`, resolving with the decision instead of what was stored, or with the rejection,
 * typed by the codes the command declares.
 */
export type ReactionCommandInvoker<Module> =
  HasPayload<Module> extends true
    ? (
        payload: PayloadInputOf<Module>,
        options?: DispatchOptions,
      ) => Promise<ReactionResultOf<Module>>
    : "payload" extends keyof Module
      ? (payload?: unknown, options?: DispatchOptions) => Promise<ReactionResultOf<Module>>
      : (options?: DispatchOptions) => Promise<ReactionResultOf<Module>>;

type ReactionResultOf<Module> = ReactionDispatchResult<RejectionCodeOf<Module>>;

/**
 * The `commands` of policy and process handlers, typed from a map of command modules.
 */
export type ReactionCommandsFacadeOf<Modules extends Readonly<Record<string, CommandModule>>> = {
  readonly [Name in keyof Modules]: ReactionCommandInvoker<Modules[Name]>;
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
    ? (payload: PayloadInputOf<Module>) => Promise<QueryResultOf<Module>>
    : "payload" extends keyof Module
      ? (payload?: unknown) => Promise<QueryResultOf<Module>>
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
