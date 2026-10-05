import { z } from "zod";
import { ConfigurationError } from "../../contracts/errors.ts";
import { createEventBuilders } from "../../modules/event.ts";
import { capitalize } from "../../modules/naming.ts";
import type { PayloadFunction } from "../../modules/payload.ts";
import type { AggregateEntry, Registry } from "../../modules/registry.ts";
import type { AggregateCollaborators } from "./collaborators.ts";
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
          create: (module.create ?? null) as EventRuntime["create"],
          apply: (module.apply ?? null) as EventRuntime["apply"],
          upcasts,
          schemaVersion: upcasts.length + 1,
        },
      ];
    }),
  );

const buildCommands = (name: string, entry: AggregateEntry): Record<string, CommandRuntime> =>
  Object.fromEntries(
    Object.entries(entry.commands).map(([key, command]) => [
      key,
      {
        key,
        type: capitalize(key),
        schema: compileSchema(command.module.payload, `aggregates.${name}.commands.${key}`),
        handler: command.module.handler as CommandRuntime["handler"],
      },
    ]),
  );

const buildAggregate = (
  name: string,
  entry: AggregateEntry,
  collaborators: Readonly<Record<string, unknown>>,
): AggregateRuntime => {
  const events = buildEvents(name, entry);
  return {
    name,
    aggregateIdField: entry.state?.aggregateId ?? `${name}Id`,
    initialState: entry.state?.initialState ?? {},
    opensWithCreate: Object.values(events).some((event) => event.create !== null),
    events,
    eventsByType: Object.fromEntries(Object.values(events).map((event) => [event.type, event])),
    eventBuilders: createEventBuilders(entry.events) as AggregateRuntime["eventBuilders"],
    collaborators,
    commands: buildCommands(name, entry),
  };
};

export interface BuildAggregatesArgs {
  readonly registry: Registry;
  /**
   * What `createCollaborators` built; an aggregate missing here gets no collaborators.
   */
  readonly collaborators: AggregateCollaborators;
}

export interface BuildAggregatesFunction {
  (args: BuildAggregatesArgs): AggregatesRuntime;
}

/**
 * Command type names must be unique across aggregates, since `app.commands` is one flat namespace.
 */
export const buildAggregates: BuildAggregatesFunction = ({ registry, collaborators }) => {
  const byName = Object.fromEntries(
    Object.entries(registry.aggregates).map(([name, entry]) => [
      name,
      buildAggregate(name, entry, collaborators[name] ?? {}),
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
