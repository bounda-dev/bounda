import type { Adapter, ReadModelStorage } from "../../adapter/adapter.ts";
import { isAdapter } from "../../adapter/adapter.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { Logger } from "../../contracts/logger.ts";
import { projectionTriggers } from "../../modules/projection.ts";
import type { QueryModule } from "../../modules/query.ts";
import type { ReadModelEntry, Registry } from "../../modules/registry.ts";
import { type FieldsRecord, fieldBuilder } from "../../modules/view.ts";
import { qualifiedEventType } from "../shared/qualified-event.ts";

export interface ProjectionRuntime {
  readonly key: string;
  readonly aggregate: string;
  readonly on: readonly string[];
  readonly project: (args: Record<string, unknown>) => unknown;
}

export interface ReadModelRuntime {
  readonly name: string;
  readonly fields: FieldsRecord;
  readonly storage: ReadModelStorage;
  /**
   * Keyed by qualified event type, `order.OrderPlaced`.
   */
  readonly projectionsByEvent: Readonly<Record<string, readonly ProjectionRuntime[]>>;
  readonly queries: Readonly<Record<string, QueryModule>>;
}

export interface ReadModelsRuntime {
  readonly byName: Readonly<Record<string, ReadModelRuntime>>;
  close(): Promise<void>;
}

const groupByEvent = (
  projections: ReadModelEntry["projections"],
): Record<string, readonly ProjectionRuntime[]> => {
  const grouped: Record<string, ProjectionRuntime[]> = {};
  for (const [aggregate, modules] of Object.entries(projections)) {
    for (const [key, module] of Object.entries(modules)) {
      const runtime: ProjectionRuntime = {
        key: `${aggregate}.${key}`,
        aggregate,
        on: projectionTriggers(key, module),
        project: module.project as ProjectionRuntime["project"],
      };
      for (const type of runtime.on) {
        const qualified = qualifiedEventType(aggregate, type);
        grouped[qualified] = [...(grouped[qualified] ?? []), runtime];
      }
    }
  }
  return grouped;
};

export interface AdapterForReadModelArgs {
  readonly name: string;
  readonly config: ResolvedConfig;
}

export interface AdapterForReadModelFunction {
  (args: AdapterForReadModelArgs): Adapter;
}

/**
 * The adapter a read model lives on: its own entry under `readModels`, or `storage`.
 */
export const adapterForReadModel: AdapterForReadModelFunction = ({ name, config }) =>
  adapterFor(name, config);

const adapterFor = (name: string, config: ResolvedConfig): Adapter => {
  const definition = config.readModels[name] ?? config.storage;
  if (!isAdapter(definition)) {
    throw new ConfigurationError(
      `Read model "${name}" is configured with "${definition.name}", which is a definition without factories. Import the adapter package's factory.`,
    );
  }
  return definition;
};

export interface CompileProjectionsArgs {
  readonly name: string;
  readonly entry: ReadModelEntry;
}

export interface CompileProjectionsFunction {
  (args: CompileProjectionsArgs): Pick<ReadModelRuntime, "name" | "projectionsByEvent">;
}

export const compileProjections: CompileProjectionsFunction = ({ name, entry }) => ({
  name,
  projectionsByEvent: groupByEvent(entry.projections),
});

export interface CompileReadModelArgs {
  readonly name: string;
  readonly entry: ReadModelEntry;
  readonly storage: ReadModelStorage;
}

export interface CompileReadModelFunction {
  (args: CompileReadModelArgs): ReadModelRuntime;
}

export const compileReadModel: CompileReadModelFunction = ({ name, entry, storage }) => ({
  ...compileProjections({ name, entry }),
  fields: entry.view.fields({ f: fieldBuilder }),
  storage,
  queries: entry.queries,
});

const buildReadModel = async (
  name: string,
  entry: ReadModelEntry,
  config: ResolvedConfig,
  logger: Logger,
): Promise<ReadModelRuntime> => {
  const fields = entry.view.fields({ f: fieldBuilder });
  const storage = await adapterFor(name, config).createReadModel<Record<string, unknown>>({
    name,
    fields,
    logger,
  });
  try {
    return compileReadModel({ name, entry, storage });
  } catch (error) {
    await storage.close().catch(() => undefined);
    throw error;
  }
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
 * Opens every read model, or none: when one fails, those already open are closed again.
 */
export const buildReadModels: BuildReadModelsFunction = async ({ registry, config, logger }) => {
  const settled = await Promise.allSettled(
    Object.entries(registry.readModels).map(
      async ([name, entry]) => [name, await buildReadModel(name, entry, config, logger)] as const,
    ),
  );
  const entries = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const failed = settled.find((result) => result.status === "rejected");
  if (failed !== undefined) {
    await Promise.all(
      entries.map(([, readModel]) => readModel.storage.close().catch(() => undefined)),
    );
    throw failed.reason;
  }
  const byName = Object.fromEntries(entries);
  return {
    byName,
    close: async () => {
      await Promise.all(Object.values(byName).map((readModel) => readModel.storage.close()));
    },
  };
};
