import { NotFoundError } from "../../contracts/errors.ts";
import { validatePayload } from "../command/validate.ts";
import type { ReadModelsRuntime } from "../read-model/build-read-models.ts";
import type { QueriesRuntime } from "./build-queries.ts";

/**
 * The untyped shape of `app.queries`. The generated types narrow it per project.
 */
export type QueriesFacadeRuntime = Readonly<
  Record<string, (payload?: unknown) => Promise<unknown>>
>;

export interface RunQueryArgs {
  readonly type: string;
  readonly payload: unknown;
}

export interface QueryRunner {
  run(args: RunQueryArgs): Promise<unknown>;
  readonly facade: QueriesFacadeRuntime;
}

export interface CreateQueryRunnerArgs {
  readonly queries: QueriesRuntime;
  readonly readModels: ReadModelsRuntime;
}

export interface CreateQueryRunnerFunction {
  (args: CreateQueryRunnerArgs): QueryRunner;
}

export const createQueryRunner: CreateQueryRunnerFunction = ({ queries, readModels }) => {
  const run = async ({ type, payload }: RunQueryArgs): Promise<unknown> => {
    const query = queries.byType[type];
    if (query === undefined) throw new NotFoundError(`Unknown query "${type}"`);
    const readModel = readModels.byName[query.readModel];
    if (readModel === undefined) throw new NotFoundError(`Unknown read model "${query.readModel}"`);
    const parsed = validatePayload({ schema: query.schema, payload, subject: `query ${type}` });
    const { table, client } = readModel.storage;
    const repositoryData =
      query.repository === null
        ? undefined
        : await query.repository({ ...(parsed as Record<string, unknown>), client, table });
    return query.handler({
      query: { type, payload: parsed },
      repositoryData,
      table,
      queries: facade,
    });
  };

  const facade: QueriesFacadeRuntime = Object.fromEntries(
    Object.values(queries.byKey).map((query) => [
      query.key,
      (payload?: unknown) => run({ type: query.type, payload }),
    ]),
  );

  return { run, facade };
};
