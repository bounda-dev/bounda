import { NotFoundError } from "../../contracts/errors.ts";
import { validatePayload } from "../command/validate.ts";
import type { RecordAccess } from "../personal-data/access.ts";
import type { ModulePorts } from "../ports/ports.ts";
import type { ReadModelRuntime, ReadModelsRuntime } from "../read-model/build-read-models.ts";
import { withPorts } from "../shared/with-ports.ts";
import type { QueriesRuntime } from "./build-queries.ts";
import { reading } from "./reading.ts";

/**
 * The untyped shape of `app.queries`. The generated types narrow it per project.
 */
export type QueriesFacadeRuntime = Readonly<
  Record<string, (payload?: unknown) => Promise<unknown>>
>;

export interface RunQueryArgs {
  readonly type: string;
  readonly payload: unknown;
  readonly actor?: string | undefined;
}

export interface QueryRunner {
  run(args: RunQueryArgs): Promise<unknown>;
  /**
   * Every query, run by `actor`, as are the queries a handler composes through it.
   */
  facade(actor: string | undefined): QueriesFacadeRuntime;
}

export interface CreateQueryRunnerArgs {
  readonly queries: QueriesRuntime;
  readonly readModels: ReadModelsRuntime;
  /**
   * What each read model's query handlers receive; `repository` reads the storage and gets none.
   */
  readonly ports: ModulePorts;
  readonly recordAccess: RecordAccess;
}

export interface CreateQueryRunnerFunction {
  (args: CreateQueryRunnerArgs): QueryRunner;
}

// A query of a read model with personal fields is recorded once its handler resolves, before its
// result is handed out, naming the persons of the rows it read: a handler may reshape what it
// read, so its result cannot tell whose data it holds.
const personalStores = (readModel: ReadModelRuntime) => {
  const { personalData, storage } = readModel;
  if (personalData === null || personalData.personal.length === 0) return null;
  return reading({ storage, person: personalData.person });
};

export const createQueryRunner: CreateQueryRunnerFunction = ({
  queries,
  readModels,
  ports,
  recordAccess,
}) => {
  const runAs = async (
    { type, payload, actor }: RunQueryArgs,
    nested: QueriesFacadeRuntime,
  ): Promise<unknown> => {
    const query = queries.byType[type];
    if (query === undefined) throw new NotFoundError(`Unknown query "${type}"`);
    const readModel = readModels.byName[query.readModel];
    if (readModel === undefined) throw new NotFoundError(`Unknown read model "${query.readModel}"`);
    const parsed = validatePayload({ schema: query.schema, payload, subject: `query ${type}` });
    const recorded = personalStores(readModel);
    const { table, client } = recorded ?? readModel.storage;
    const repositoryData =
      query.repository === null
        ? undefined
        : await query.repository({ ...(parsed as Record<string, unknown>), client, table });
    const args = { query: { type, payload: parsed }, repositoryData, table, queries: nested };
    const readModelPorts = ports[query.readModel] ?? {};
    const result = await query.handler(
      Object.keys(readModelPorts).length === 0 ? args : withPorts(readModelPorts, args),
    );
    if (recorded !== null) {
      await recordAccess({
        operation: "query",
        detail: { query: query.key, readModel: query.readModel },
        actor,
        persons: recorded.persons,
      });
    }
    return result;
  };

  const facade = (actor: string | undefined): QueriesFacadeRuntime => {
    const built: QueriesFacadeRuntime = Object.fromEntries(
      Object.values(queries.byKey).map((query) => [
        query.key,
        (payload?: unknown) => runAs({ type: query.type, payload, actor }, built),
      ]),
    );
    return built;
  };

  return { run: (args) => runAs(args, facade(args.actor)), facade };
};
