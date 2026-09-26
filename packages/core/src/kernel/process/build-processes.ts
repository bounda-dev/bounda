import { z } from "zod";
import { selectCollaborators } from "../../config/collaborators.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import { parseDuration } from "../../contracts/duration.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { capitalize } from "../../modules/naming.ts";
import type { ProcessEntry } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";

/**
 * A compiled process: which events start, feed and complete it, its state schema and handlers,
 * how long an instance may stay open and the collaborators chosen from the configuration.
 */
export interface ProcessRuntime {
  readonly name: string;
  readonly type: string;
  readonly aggregate: string;
  readonly startedBy: ReadonlySet<string>;
  readonly completedBy: ReadonlySet<string>;
  readonly timeoutMs: number;
  readonly initialState: object;
  readonly stateSchema: z.ZodType | null;
  readonly handlers: Readonly<Record<string, (args: Record<string, unknown>) => unknown>>;
  readonly timeoutHandler: ((args: Record<string, unknown>) => unknown) | null;
  readonly collaborators: Readonly<Record<string, unknown>>;
}

export interface ProcessesRuntime {
  readonly all: readonly ProcessRuntime[];
  readonly byName: Readonly<Record<string, ProcessRuntime>>;
  readonly byEvent: Readonly<Record<string, readonly ProcessRuntime[]>>;
}

const compileState = (
  path: string,
  entry: ProcessEntry,
): { readonly schema: z.ZodType | null; readonly initial: object } => {
  if (entry.module.state === undefined) return { schema: null, initial: {} };
  const schema = entry.module.state({ z });
  if (!(schema instanceof z.ZodType)) {
    throw new ConfigurationError(`${path}: state must return a Zod schema`);
  }
  const initial = schema.safeParse({});
  if (!initial.success) {
    throw new ConfigurationError(
      `${path}: state schema must accept an empty object; give every field a default`,
    );
  }
  return { schema, initial: initial.data as object };
};

const knownEvents = (
  path: string,
  names: readonly string[],
  known: ReadonlySet<string>,
): ReadonlySet<string> => {
  for (const name of names) {
    if (!known.has(name)) {
      throw new ConfigurationError(`${path}: "${name}" is not an event of this aggregate`);
    }
  }
  return new Set(names);
};

const buildProcess = (
  aggregate: string,
  key: string,
  entry: ProcessEntry,
  eventNames: ReadonlySet<string>,
  config: ResolvedConfig,
): ProcessRuntime => {
  const path = `aggregates.${aggregate}.processes.${key}`;
  const events = Object.fromEntries([...eventNames].map((name) => [name, name]));
  const declared = (
    entry.module.config as (args: {
      events: Record<string, string>;
    }) => ReturnType<ProcessEntry["module"]["config"]>
  )({ events });
  const state = compileState(path, entry);
  return {
    name: `${aggregate}.${key}`,
    type: capitalize(key),
    aggregate,
    startedBy: knownEvents(path, declared.startedBy, eventNames),
    completedBy: knownEvents(path, declared.completedBy ?? [], eventNames),
    timeoutMs:
      declared.timeout === undefined
        ? config.forAggregate(aggregate).processes.timeoutMs
        : parseDuration(declared.timeout),
    initialState: state.initial,
    stateSchema: state.schema,
    handlers: Object.fromEntries(
      Object.entries(entry.handlers).map(([eventKey, handler]) => {
        const type = capitalize(eventKey);
        if (!eventNames.has(type)) {
          throw new ConfigurationError(
            `${path}.handlers.${eventKey}: "${type}" is not an event of this aggregate`,
          );
        }
        return [type, handler.handler as ProcessRuntime["handlers"][string]];
      }),
    ),
    timeoutHandler: (entry.timeout?.handler as ProcessRuntime["timeoutHandler"]) ?? null,
    collaborators: selectCollaborators({
      owner: `Process "${aggregate}.${key}"`,
      path: `processes.${aggregate}.${key}`,
      implementations: entry.collaborators ?? {},
      config: config.processes[aggregate]?.[key],
    }),
  };
};

export interface BuildProcessesArgs {
  readonly registry: Registry;
  readonly config: ResolvedConfig;
}

export interface BuildProcessesFunction {
  (args: BuildProcessesArgs): ProcessesRuntime;
}

/**
 * Compiles every process of the registry, resolving its config against the aggregate's event
 * names, and indexes processes by every event type they care about.
 */
export const buildProcesses: BuildProcessesFunction = ({ registry, config }) => {
  const all = Object.entries(registry.aggregates).flatMap(([aggregate, entry]) => {
    const eventNames = new Set(Object.keys(entry.events).map(capitalize));
    return Object.entries(entry.processes).map(([key, process]) =>
      buildProcess(aggregate, key, process, eventNames, config),
    );
  });
  const byEvent: Record<string, ProcessRuntime[]> = {};
  for (const process of all) {
    const interested = new Set([
      ...process.startedBy,
      ...process.completedBy,
      ...Object.keys(process.handlers),
    ]);
    for (const type of interested) byEvent[type] = [...(byEvent[type] ?? []), process];
  }
  return {
    all,
    byName: Object.fromEntries(all.map((process) => [process.name, process])),
    byEvent,
  };
};
