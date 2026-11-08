import { z } from "zod";
import { ConfigurationError } from "../../contracts/errors.ts";
import { capitalize } from "../../modules/naming.ts";
import type { ReadModelsRuntime } from "../read-model/build-read-models.ts";

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

// A repository receives the payload's fields next to these, which would take their place.
const REPOSITORY_ARGS: readonly string[] = ["client", "table", "actor"];

export interface CheckPayloadFieldsFunction {
  (path: string, fields: readonly string[]): void;
}

/**
 * Throws `ConfigurationError` when a payload field is named as one of a repository's own
 * arguments.
 */
export const checkPayloadFields: CheckPayloadFieldsFunction = (path, fields) => {
  const shadowed = REPOSITORY_ARGS.find((name) => fields.includes(name));
  if (shadowed !== undefined) {
    throw new ConfigurationError(
      `${path}: payload field "${shadowed}" is what the repository receives as its own ${shadowed}; give the field another name`,
    );
  }
};

/**
 * Query keys must be unique across read models, since `app.queries` is one flat namespace, and a
 * query with a repository cannot have a payload field named as one of the repository's own
 * arguments.
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
      // Checked again on each payload the query parses, which another schema may shape.
      if (module.repository !== undefined && schema instanceof z.ZodObject) {
        checkPayloadFields(path, Object.keys(schema.shape));
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
