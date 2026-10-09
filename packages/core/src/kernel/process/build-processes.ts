import { z } from "zod";
import type { ResolvedConfig } from "../../config/types.ts";
import { parseDuration } from "../../contracts/duration.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { capitalize, toKebabCase } from "../../modules/naming.ts";
import type { ProcessCorrelation, ProcessEntry } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { qualifiedEventType } from "../shared/qualified-event.ts";
import { deadlineFieldsOf, processStateArgs, TIMEOUT_DEADLINE } from "./deadlines.ts";

export interface ProcessRuntime {
  readonly name: string;
  readonly aggregate: string;
  readonly startedBy: ReadonlySet<string>;
  readonly completedBy: ReadonlySet<string>;
  // How long an instance stays open, not one run of a handler: that is `handlerTimeoutMs`.
  readonly lifetimeMs: number;
  readonly handlerTimeoutMs: number;
  readonly initialState: object;
  readonly stateSchema: z.ZodType | null;
  readonly handlers: Readonly<Record<string, (args: Record<string, unknown>) => unknown>>;
  readonly deadlineFields: readonly string[];
  /**
   * Includes the `at-timeout.ts` handler under `timeout`, when there is one.
   */
  readonly deadlineHandlers: Readonly<Record<string, (args: Record<string, unknown>) => unknown>>;
  readonly ports: Readonly<Record<string, unknown>>;
  /**
   * The id of the instance an event belongs to: what `correlate` says for it, the id field of an
   * event of another aggregate, or the event's `aggregateId` for the process's own aggregate;
   * `null` when the event belongs to none. Throws when `correlate` throws or either gives anything
   * but a non-empty string or `null`.
   */
  instanceOf(event: StoredEvent): string | null;
}

export interface ProcessesRuntime {
  readonly all: readonly ProcessRuntime[];
  readonly byName: Readonly<Record<string, ProcessRuntime>>;
  /**
   * Keyed by qualified event type, `order.OrderPlaced`.
   */
  readonly byEvent: Readonly<Record<string, readonly ProcessRuntime[]>>;
}

const compileState = (
  path: string,
  entry: ProcessEntry,
): { readonly schema: z.ZodType | null; readonly initial: object } => {
  if (entry.module.state === undefined) return { schema: null, initial: {} };
  const schema = entry.module.state(processStateArgs);
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

type Correlator = (event: StoredEvent) => string | null;

type AppEvents = Readonly<Record<string, Readonly<Record<string, string>>>>;

const compileDeadlines = (
  path: string,
  entry: ProcessEntry,
  fields: readonly string[],
): ProcessRuntime["deadlineHandlers"] => {
  if (fields.includes(TIMEOUT_DEADLINE)) {
    throw new ConfigurationError(
      `${path}: the deadline "timeout" is reserved for config.timeout; give the field another name`,
    );
  }
  const handlers = entry.deadlines ?? {};
  for (const field of fields) {
    if (handlers[field] === undefined) {
      throw new ConfigurationError(
        `${path}: the deadline "${field}" has no handler; add at-${toKebabCase(field)}.ts to the process`,
      );
    }
  }
  for (const field of Object.keys(handlers)) {
    if (field !== TIMEOUT_DEADLINE && !fields.includes(field)) {
      throw new ConfigurationError(
        `${path}: at-${toKebabCase(field)}.ts handles "${field}", which the state does not declare with deadline(); a deadline() wrapped in .describe(), .optional() or the like no longer counts`,
      );
    }
  }
  return Object.fromEntries(
    Object.entries(handlers).map(([field, handler]) => [
      field,
      handler.handler as ProcessRuntime["handlers"][string],
    ]),
  );
};

const knownEvents = (
  path: string,
  names: readonly string[],
  known: ReadonlySet<string>,
): ReadonlySet<string> => {
  for (const name of names) {
    if (!known.has(name)) {
      throw new ConfigurationError(
        `${path}: "${name}" is not an event of the app; name events as events.<aggregate>.<Event>`,
      );
    }
  }
  return new Set(names);
};

const compileHandlers = (
  path: string,
  entry: ProcessEntry,
  known: ReadonlySet<string>,
): ProcessRuntime["handlers"] =>
  Object.fromEntries(
    Object.entries(entry.handlers).flatMap(([source, handlers]) =>
      Object.entries(handlers).map(([eventKey, handler]) => {
        const qualified = qualifiedEventType(source, capitalize(eventKey));
        if (!known.has(qualified)) {
          throw new ConfigurationError(
            `${path}.handlers.${source}.${eventKey}: "${qualified}" is not an event of the app`,
          );
        }
        return [qualified, handler.handler as ProcessRuntime["handlers"][string]];
      }),
    ),
  );

const isCorrelation = (value: unknown): value is ProcessCorrelation =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "event") === "string" &&
  typeof Reflect.get(value, "correlate") === "function";

const compileCorrelate = (
  path: string,
  entry: ProcessEntry,
  events: AppEvents,
): Record<string, Correlator> => {
  const { correlate } = entry.module;
  if (correlate === undefined) return {};
  if (typeof correlate !== "function") {
    throw new ConfigurationError(
      `${path}: correlate must be a function of { from } returning from.<aggregate>.<Event>(…) for each event`,
    );
  }
  const from = Object.fromEntries(
    Object.entries(events).map(([aggregate, byType]) => [
      aggregate,
      Object.fromEntries(
        Object.entries(byType).map(([type, qualified]) => [
          type,
          (correlator: Correlator): ProcessCorrelation => ({
            event: qualified,
            correlate: correlator,
          }),
        ]),
      ),
    ]),
  );
  let declared: unknown;
  try {
    declared = (correlate as (args: { readonly from: object }) => unknown)({ from });
  } catch (error) {
    throw new ConfigurationError(
      `${path}.correlate failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!Array.isArray(declared) || !declared.every(isCorrelation)) {
    throw new ConfigurationError(
      `${path}.correlate: return a list of from.<aggregate>.<Event>(…), one for each event`,
    );
  }
  const correlators: Record<string, Correlator> = {};
  for (const { event, correlate: correlator } of declared) {
    if (correlators[event] !== undefined) {
      throw new ConfigurationError(`${path}.correlate: "${event}" is correlated twice`);
    }
    correlators[event] = correlator as Correlator;
  }
  return correlators;
};

type IdFieldRoute = { readonly correlate: Correlator } | { readonly refused: string };

// An event of another aggregate whose payload schema declares the id field of the process's
// aggregate belongs to the instance it names, and to none when it is null or empty. Any other
// value goes on as it is, for `instanceOf` to refuse. Only a plain object schema says what is
// stored: a transform's output, which is, cannot be read from it.
const byIdField = (
  aggregates: AggregatesRuntime,
  aggregate: string,
  qualified: string,
): IdFieldRoute => {
  const field = aggregates.byName[aggregate]?.aggregateIdField;
  const [source = "", type = ""] = qualified.split(".");
  const schema = aggregates.byName[source]?.eventsByType[type]?.schema ?? null;
  const correlateIt = `say which instance it belongs to with from.${qualified}(…) in correlate`;
  if (schema !== null && !(schema instanceof z.ZodObject)) {
    return {
      refused: `its payload schema is not a plain z.object, so its "${field}" cannot be read; ${correlateIt}`,
    };
  }
  if (field === undefined || schema === null || !(field in schema.shape)) {
    return { refused: `give its payload "${field}" or ${correlateIt}` };
  }
  return {
    correlate: (event) => {
      const id: unknown = Reflect.get(event.payload as object, field);
      return id === null || id === undefined || id === "" ? null : (id as string);
    },
  };
};

const buildProcess = (
  aggregate: string,
  key: string,
  entry: ProcessEntry,
  events: AppEvents,
  known: ReadonlySet<string>,
  config: ResolvedConfig,
  aggregates: AggregatesRuntime,
): ProcessRuntime => {
  const path = `aggregates.${aggregate}.processes.${key}`;
  const declared = (
    entry.module.config as (args: {
      events: Readonly<Record<string, Readonly<Record<string, string>>>>;
    }) => ReturnType<ProcessEntry["module"]["config"]>
  )({ events });
  const state = compileState(path, entry);
  const deadlineFields = deadlineFieldsOf(state.schema);
  const startedBy = knownEvents(path, declared.startedBy, known);
  const completedBy = knownEvents(path, declared.completedBy ?? [], known);
  const handlers = compileHandlers(path, entry, known);
  const correlate = compileCorrelate(path, entry, events);
  const own = (qualified: string): boolean => qualified.startsWith(`${aggregate}.`);
  for (const qualified of new Set([...startedBy, ...completedBy, ...Object.keys(handlers)])) {
    if (own(qualified) || correlate[qualified] !== undefined) continue;
    const route = byIdField(aggregates, aggregate, qualified);
    if ("refused" in route) {
      throw new ConfigurationError(
        `${path}: "${qualified}" comes from another aggregate; ${route.refused}`,
      );
    }
    correlate[qualified] = route.correlate;
  }
  return {
    name: `${aggregate}.${key}`,
    aggregate,
    startedBy,
    completedBy,
    lifetimeMs:
      declared.timeout === undefined
        ? config.forAggregate(aggregate).processes.timeoutMs
        : parseDuration(declared.timeout),
    handlerTimeoutMs: config.forAggregate(aggregate).processes.handlerTimeoutMs,
    initialState: state.initial,
    stateSchema: state.schema,
    handlers,
    deadlineFields,
    deadlineHandlers: compileDeadlines(path, entry, deadlineFields),
    ports: aggregates.byName[aggregate]?.ports ?? {},
    instanceOf: (event) => {
      const qualified = qualifiedEventType(event.aggregateType, event.type);
      const correlator = correlate[qualified];
      if (correlator === undefined) {
        return event.aggregateType === aggregate ? event.aggregateId : null;
      }
      const instanceId: unknown = correlator(event);
      if (instanceId === null || (typeof instanceId === "string" && instanceId !== "")) {
        return instanceId;
      }
      const returned = JSON.stringify(instanceId) ?? String(instanceId);
      throw new ConfigurationError(
        `${path}.correlate returned ${returned} for ${qualified} ${event.id}; expected the id of the ${aggregate} it belongs to, or null`,
      );
    },
  };
};

export interface BuildProcessesArgs {
  readonly registry: Registry;
  readonly aggregates: AggregatesRuntime;
  readonly config: ResolvedConfig;
}

export interface BuildProcessesFunction {
  (args: BuildProcessesArgs): ProcessesRuntime;
}

/**
 * An event of another aggregate that a process listens to belongs to the instance its payload's
 * id field names, unless `correlate` says otherwise; one with neither is a configuration error.
 */
export const buildProcesses: BuildProcessesFunction = ({ registry, aggregates, config }) => {
  const events = Object.fromEntries(
    Object.entries(registry.aggregates).map(([aggregate, entry]) => [
      aggregate,
      Object.fromEntries(
        Object.keys(entry.events).map((eventKey) => [
          capitalize(eventKey),
          qualifiedEventType(aggregate, capitalize(eventKey)),
        ]),
      ),
    ]),
  );
  const known = new Set(Object.values(events).flatMap((byType) => Object.values(byType)));
  const all = Object.entries(registry.aggregates).flatMap(([aggregate, entry]) =>
    Object.entries(entry.processes).map(([key, process]) =>
      buildProcess(aggregate, key, process, events, known, config, aggregates),
    ),
  );
  const byEvent: Record<string, ProcessRuntime[]> = {};
  for (const process of all) {
    const interested = new Set([
      ...process.startedBy,
      ...process.completedBy,
      ...Object.keys(process.handlers),
    ]);
    for (const qualified of interested) {
      byEvent[qualified] = [...(byEvent[qualified] ?? []), process];
    }
  }
  return {
    all,
    byName: Object.fromEntries(all.map((process) => [process.name, process])),
    byEvent,
  };
};
