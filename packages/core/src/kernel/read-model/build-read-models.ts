import type { Adapter, ReadModelPorts } from "../../adapter/adapter.ts";
import { isAdapter } from "../../adapter/adapter.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { Logger } from "../../contracts/logger.ts";
import { capitalize } from "../../modules/naming.ts";
import type { ProjectionModule } from "../../modules/projection.ts";
import type { QueryModule } from "../../modules/query.ts";
import type { ReadModelEntry, Registry } from "../../modules/registry.ts";
import { type FieldsRecord, fieldBuilder } from "../../modules/view.ts";

/**
 * A compiled projection: the event types it reacts to and its `project`.
 */
export interface ProjectionRuntime {
  readonly key: string;
  readonly on: readonly string[];
  readonly project: (args: Record<string, unknown>) => unknown;
}

/**
 * Everything the kernel needs about one read model, compiled at boot.
 */
export interface ReadModelRuntime {
  readonly name: string;
  readonly fields: FieldsRecord;
  readonly ports: ReadModelPorts;
  readonly projectionsByEvent: Readonly<Record<string, readonly ProjectionRuntime[]>>;
  readonly queries: Readonly<Record<string, QueryModule>>;
}

export interface ReadModelsRuntime {
  readonly byName: Readonly<Record<string, ReadModelRuntime>>;
  close(): Promise<void>;
}

const triggersOf = (key: string, module: ProjectionModule): readonly string[] =>
  module.on === undefined
    ? [capitalize(key)]
    : typeof module.on === "string"
      ? [module.on]
      : module.on;

const groupByEvent = (
  projections: Readonly<Record<string, ProjectionModule>>,
): Record<string, readonly ProjectionRuntime[]> => {
  const grouped: Record<string, ProjectionRuntime[]> = {};
  for (const [key, module] of Object.entries(projections)) {
    const runtime: ProjectionRuntime = {
      key,
      on: triggersOf(key, module),
      project: module.project as ProjectionRuntime["project"],
    };
    for (const type of runtime.on) {
      grouped[type] = [...(grouped[type] ?? []), runtime];
    }
  }
  return grouped;
};

const adapterFor = (name: string, config: ResolvedConfig): Adapter => {
  const definition = config.readModels[name] ?? config.storage;
  if (!isAdapter(definition)) {
    throw new ConfigurationError(
      `Read model "${name}" is configured with "${definition.name}", which is a definition without factories. Import the adapter package's factory.`,
    );
  }
  return definition;
};

const buildReadModel = async (
  name: string,
  entry: ReadModelEntry,
  config: ResolvedConfig,
  logger: Logger,
): Promise<ReadModelRuntime> => {
  const fields = entry.view.fields({ f: fieldBuilder });
  const ports = await adapterFor(name, config).createReadModel<Record<string, unknown>>({
    name,
    fields,
    logger,
  });
  return {
    name,
    fields,
    ports,
    projectionsByEvent: groupByEvent(entry.projections),
    queries: entry.queries,
  };
};

export interface BuildReadModelsArgs {
  readonly registry: Registry;
  readonly config: ResolvedConfig;
  readonly logger: Logger;
}

export interface BuildReadModelsFunction {
  (args: BuildReadModelsArgs): Promise<ReadModelsRuntime>;
}

/**
 * Compiles the read side of the registry: field definitions, one table per read model on its
 * configured adapter, and projections indexed by the event types they react to.
 */
export const buildReadModels: BuildReadModelsFunction = async ({ registry, config, logger }) => {
  const entries = await Promise.all(
    Object.entries(registry.readModels).map(
      async ([name, entry]) => [name, await buildReadModel(name, entry, config, logger)] as const,
    ),
  );
  const byName = Object.fromEntries(entries);
  return {
    byName,
    close: async () => {
      await Promise.all(Object.values(byName).map((readModel) => readModel.ports.close()));
    },
  };
};
