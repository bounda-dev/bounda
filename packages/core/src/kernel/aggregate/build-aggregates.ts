import { z } from "zod";
import { selectCollaborators } from "../../config/collaborators.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { createEventBuilders } from "../../modules/event.ts";
import { capitalize } from "../../modules/naming.ts";
import type { PayloadFunction } from "../../modules/payload.ts";
import type { AggregateEntry, Registry } from "../../modules/registry.ts";
import type {
  AggregateRuntime,
  AggregatesRuntime,
  CommandRuntime,
  EventRuntime,
} from "./runtime.ts";

const compileSchema = (payload: PayloadFunction | undefined, path: string): z.ZodType | null => {
  if (payload === undefined) return null;
  const schema = payload({ z });
  if (!(schema instanceof z.ZodType)) {
    throw new ConfigurationError(`${path}: payload must return a Zod schema`);
  }
  return schema;
};

const buildEvents = (name: string, entry: AggregateEntry): Record<string, EventRuntime> =>
  Object.fromEntries(
    Object.entries(entry.events).map(([key, module]) => {
      const upcasts = entry.upcasts?.[key]?.upcasts ?? [];
      return [
        key,
        {
          key,
          type: capitalize(key),
          schema: compileSchema(module.payload, `aggregates.${name}.events.${key}`),
          apply: module.apply as EventRuntime["apply"],
          upcasts,
          schemaVersion: upcasts.length + 1,
        },
      ];
    }),
  );

const buildCommands = (
  name: string,
  entry: AggregateEntry,
  config: ResolvedConfig,
): Record<string, CommandRuntime> =>
  Object.fromEntries(
    Object.entries(entry.commands).map(([key, command]) => [
      key,
      {
        key,
        type: capitalize(key),
        schema: compileSchema(command.module.payload, `aggregates.${name}.commands.${key}`),
        handler: command.module.handler as CommandRuntime["handler"],
        collaborators: selectCollaborators({
          commandName: key,
          implementations: command.collaborators ?? {},
          config: config.commands[key],
        }),
      },
    ]),
  );

const buildAggregate = (
  name: string,
  entry: AggregateEntry,
  config: ResolvedConfig,
): AggregateRuntime => {
  const events = buildEvents(name, entry);
  return {
    name,
    aggregateIdField: entry.state?.aggregateId ?? `${name}Id`,
    initialState: entry.state?.initialState ?? {},
    events,
    eventsByType: Object.fromEntries(Object.values(events).map((event) => [event.type, event])),
    eventBuilders: createEventBuilders(entry.events) as AggregateRuntime["eventBuilders"],
    commands: buildCommands(name, entry, config),
  };
};

export interface BuildAggregatesArgs {
  readonly registry: Registry;
  readonly config: ResolvedConfig;
}

export interface BuildAggregatesFunction {
  (args: BuildAggregatesArgs): AggregatesRuntime;
}

/**
 * Compiles the write side of the registry: schemas, appliers, event builders and collaborator
 * selection, once, at boot. Duplicate command type names across aggregates are rejected because
 * `app.commands` is one flat namespace.
 */
export const buildAggregates: BuildAggregatesFunction = ({ registry, config }) => {
  const byName = Object.fromEntries(
    Object.entries(registry.aggregates).map(([name, entry]) => [
      name,
      buildAggregate(name, entry, config),
    ]),
  );
  const commandsByType: Record<string, AggregatesRuntime["commandsByType"][string]> = {};
  for (const aggregate of Object.values(byName)) {
    for (const command of Object.values(aggregate.commands)) {
      const existing = commandsByType[command.type];
      if (existing !== undefined) {
        throw new ConfigurationError(
          `Command "${command.type}" is defined in both "${existing.aggregate.name}" and "${aggregate.name}"`,
        );
      }
      commandsByType[command.type] = { aggregate, command };
    }
  }
  return { byName, commandsByType };
};
