import { z } from "zod";
import type { ResolvedConfig } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { createEventBuilders } from "../../modules/event.ts";
import { capitalize } from "../../modules/naming.ts";
import type { EventPayloadArgs } from "../../modules/payload.ts";
import { person, personal } from "../../modules/personal.ts";
import type { AggregateEntry, Registry } from "../../modules/registry.ts";
import { personalMarksOf } from "../personal-data/marks.ts";
import type { ModulePorts } from "../ports/ports.ts";
import type {
  AggregateRuntime,
  AggregateSnapshotRuntime,
  AggregatesRuntime,
  CommandRuntime,
  EventRuntime,
} from "./runtime.ts";

const compileSchema = (
  payload: ((args: EventPayloadArgs) => unknown) | undefined,
  path: string,
): z.ZodType | null => {
  if (payload === undefined) return null;
  const schema = payload({ z, personal, person });
  if (!(schema instanceof z.ZodType)) {
    throw new ConfigurationError(`${path}: payload must return a Zod schema`);
  }
  return schema;
};

const buildEvents = (name: string, entry: AggregateEntry): Record<string, EventRuntime> =>
  Object.fromEntries(
    Object.entries(entry.events).map(([key, module]) => {
      const upcasts = entry.upcasts?.[key]?.upcasts ?? [];
      const path = `aggregates.${name}.events.${key}`;
      const schema = compileSchema(module.payload, path);
      return [
        key,
        {
          key,
          type: capitalize(key),
          schema,
          begin: (module.begin ?? null) as EventRuntime["begin"],
          evolve: (module.evolve ?? null) as EventRuntime["evolve"],
          upcasts,
          schemaVersion: upcasts.length + 1,
          personal: personalMarksOf({ schema, path }),
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
        rejections: (command.module.rejections ?? null) as CommandRuntime["rejections"],
      },
    ]),
  );

const buildSnapshot = (
  name: string,
  entry: AggregateEntry,
  config: ResolvedConfig | undefined,
): AggregateSnapshotRuntime | null => {
  const settings = config?.forAggregate(name).snapshot ?? null;
  if (settings === null) return null;
  if (entry.stateFingerprint === undefined) {
    throw new ConfigurationError(
      `runtime.overrides.${name}.snapshot: the registry has no state fingerprint for "${name}"; run bounda generate`,
    );
  }
  return {
    every: settings.every,
    verify: settings.verify,
    fingerprint: `${entry.stateFingerprint}:${settings.version}`,
  };
};

const buildAggregate = (
  name: string,
  entry: AggregateEntry,
  ports: Readonly<Record<string, unknown>>,
  config: ResolvedConfig | undefined,
): AggregateRuntime => {
  const events = buildEvents(name, entry);
  return {
    name,
    aggregateIdField: entry.state?.aggregateId ?? `${name}Id`,
    initialState: entry.state?.initialState ?? {},
    opensWithBegin: Object.values(events).some((event) => event.begin !== null),
    snapshot: buildSnapshot(name, entry, config),
    events,
    eventsByType: Object.fromEntries(Object.values(events).map((event) => [event.type, event])),
    eventBuilders: createEventBuilders(entry.events) as AggregateRuntime["eventBuilders"],
    ports,
    commands: buildCommands(name, entry),
  };
};

export interface BuildAggregatesArgs {
  readonly registry: Registry;
  /**
   * What `createPorts` built; an aggregate missing here gets no ports.
   */
  readonly ports: ModulePorts;
  /**
   * Where the snapshot settings come from; left out, no aggregate takes snapshots.
   */
  readonly config?: ResolvedConfig;
}

export interface BuildAggregatesFunction {
  (args: BuildAggregatesArgs): AggregatesRuntime;
}

/**
 * Command type names must be unique across aggregates, since `app.commands` is one flat namespace.
 */
export const buildAggregates: BuildAggregatesFunction = ({ registry, ports, config }) => {
  const byName = Object.fromEntries(
    Object.entries(registry.aggregates).map(([name, entry]) => [
      name,
      buildAggregate(name, entry, ports[name] ?? {}, config),
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
