import { z } from "zod";
import { ConfigurationError } from "../../contracts/errors.ts";
import { capitalize } from "../../modules/naming.ts";
import type { ReadModelsRuntime } from "../read-model/build-read-models.ts";

/**
 * A compiled query: its read model, schema, optional repository and handler.
 */
export interface QueryRuntime {
  readonly key: string;
  readonly type: string;
  readonly readModel: string;
  readonly schema: z.ZodType | null;
  readonly repository: ((args: Record<string, unknown>) => unknown) | null;
  readonly handler: (args: Record<string, unknown>) => unknown;
}

export interface QueriesRuntime {
  readonly byKey: Readonly<Record<string, QueryRuntime>>;
  readonly byType: Readonly<Record<string, QueryRuntime>>;
}

export interface BuildQueriesArgs {
  readonly readModels: ReadModelsRuntime;
}

export interface BuildQueriesFunction {
  (args: BuildQueriesArgs): QueriesRuntime;
}

/**
 * Compiles every query of every read model. Query keys are one flat namespace because
 * `app.queries` is.
 */
export const buildQueries: BuildQueriesFunction = ({ readModels }) => {
  const byKey: Record<string, QueryRuntime> = {};
  for (const readModel of Object.values(readModels.byName)) {
    for (const [key, module] of Object.entries(readModel.queries)) {
      const existing = byKey[key];
      if (existing !== undefined) {
        throw new ConfigurationError(
          `Query "${key}" is defined in both "${existing.readModel}" and "${readModel.name}"`,
        );
      }
      const path = `readModels.${readModel.name}.queries.${key}`;
      const schema = module.payload === undefined ? null : module.payload({ z });
      if (schema !== null && !(schema instanceof z.ZodType)) {
        throw new ConfigurationError(`${path}: payload must return a Zod schema`);
      }
      byKey[key] = {
        key,
        type: capitalize(key),
        readModel: readModel.name,
        schema,
        repository: (module.repository as QueryRuntime["repository"]) ?? null,
        handler: module.handler as QueryRuntime["handler"],
      };
    }
  }
  return {
    byKey,
    byType: Object.fromEntries(Object.values(byKey).map((query) => [query.type, query])),
  };
};
