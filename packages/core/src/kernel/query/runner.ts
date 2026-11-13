import type { RestrictionView } from "../../adapter/storage/restricted-persons.ts";
import type { ErrorText } from "../../config/types.ts";
import { NotFoundError } from "../../contracts/errors.ts";
import type { RestrictionBasis } from "../../modules/personal-data.ts";
import type { QueryOptions } from "../../modules/query.ts";
import { validatePayload } from "../command/validate.ts";
import { type RecordAccess, recorded } from "../personal-data/access.ts";
import { checkIncludeRestricted, restrictionViewOf } from "../personal-data/restricted-reads.ts";
import type { ModulePorts } from "../ports/ports.ts";
import type { ReadModelRuntime, ReadModelsRuntime } from "../read-model/build-read-models.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { runtimeText } from "../shared/runtime-text.ts";
import { withPorts } from "../shared/with-ports.ts";
import { ATTRIBUTES, actorAttribute, traced } from "../telemetry.ts";
import { checkPayloadFields, type QueriesRuntime } from "./build-queries.ts";
import { reading } from "./reading.ts";

/**
 * The untyped shape of `app.queries`. The generated types narrow it per project.
 */
export type QueriesFacadeRuntime = Readonly<
  Record<string, (payload?: unknown, options?: QueryOptions) => Promise<unknown>>
>;

export interface RunQueryArgs {
  readonly type: string;
  readonly payload: unknown;
  readonly actor?: string | undefined;
  readonly includeRestricted?: RestrictionBasis | undefined;
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
  readonly errorText: ErrorText;
}

export interface CreateQueryRunnerFunction {
  (args: CreateQueryRunnerArgs): QueryRunner;
}

// The stores of a read model with a field marked `.person()`, which leave out the rows of
// restricted persons; a read model without one has no row of anyone's.
const personalStores = (readModel: ReadModelRuntime, view: RestrictionView) => {
  const { personalData, storage, name } = readModel;
  if (personalData === null) return null;
  return reading({
    storage,
    readModel: name,
    person: personalData.person,
    personal: personalData.personal,
    view,
  });
};

export const createQueryRunner: CreateQueryRunnerFunction = ({
  queries,
  readModels,
  ports,
  recordAccess,
  errorText,
}) => {
  const runAs = async (
    { type, payload, actor, includeRestricted: asked }: RunQueryArgs,
    nested: QueriesFacadeRuntime,
  ): Promise<unknown> => {
    const includeRestricted = checkIncludeRestricted(`query ${type}`, asked);
    const query = queries.byType[type];
    if (query === undefined) throw runtimeText(new NotFoundError(`Unknown query "${type}"`));
    const readModel = readModels.byName[query.readModel];
    if (readModel === undefined)
      throw runtimeText(new NotFoundError(`Unknown read model "${query.readModel}"`));
    return traced({
      errorText,
      name: `bounda.query ${type}`,
      attributes: {
        [ATTRIBUTES.queryType]: type,
        [ATTRIBUTES.readModel]: query.readModel,
        ...actorAttribute(actor),
      },
      run: async () => {
        const parsed = validatePayload({ schema: query.schema, payload, subject: `query ${type}` });
        const stores = personalStores(readModel, restrictionViewOf(includeRestricted));
        const { table, client } = stores ?? readModel.storage;
        if (query.repository !== null && isRecord(parsed)) {
          checkPayloadFields(
            `readModels.${query.readModel}.queries.${query.key}`,
            Object.keys(parsed),
          );
        }
        const run = async (): Promise<unknown> => {
          const repositoryData =
            query.repository === null
              ? undefined
              : await query.repository({
                  ...(parsed as Record<string, unknown>),
                  client,
                  table,
                  actor,
                });
          const args = {
            query: { type, payload: parsed },
            repositoryData,
            table,
            queries: nested,
            actor,
          };
          const readModelPorts = ports[query.readModel] ?? {};
          return query.handler(
            Object.keys(readModelPorts).length === 0 ? args : withPorts(readModelPorts, args),
          );
        };
        // Recorded once its handler settles, before its result or error is handed out, naming
        // the persons of the rows it read: a handler may reshape what it read, so its result
        // cannot tell whose data it holds. A read model with no field marked `.personal()` is
        // recorded only when restricted rows were asked for.
        if (
          stores === null ||
          (includeRestricted === undefined && readModel.personalData?.personal.length === 0)
        ) {
          return run();
        }
        return recorded(
          async (outcome) =>
            recordAccess({
              operation: "query",
              detail: { query: query.key, readModel: query.readModel },
              actor,
              persons: stores.persons,
              outcome,
              unattributed: stores.unattributed,
              restricted:
                includeRestricted === undefined
                  ? null
                  : {
                      basis: includeRestricted,
                      persons: await readModel.storage.restricted.among(
                        stores.persons,
                        "unrestricted",
                      ),
                    },
            }),
          run,
        );
      },
    });
  };

  // A query a handler composes reads restricted rows on the basis its caller named, unless it names
  // its own.
  const facadeOn = (
    actor: string | undefined,
    inherited: RestrictionBasis | undefined,
  ): QueriesFacadeRuntime => {
    const built: QueriesFacadeRuntime = Object.fromEntries(
      Object.values(queries.byKey).map((query) => [
        query.key,
        (payload?: unknown, options?: QueryOptions) => {
          const includeRestricted = options?.includeRestricted ?? inherited;
          return runAs(
            { type: query.type, payload, actor, includeRestricted },
            includeRestricted === inherited ? built : facadeOn(actor, includeRestricted),
          );
        },
      ]),
    );
    return built;
  };

  return {
    run: (args) => runAs(args, facadeOn(args.actor, args.includeRestricted)),
    facade: (actor) => facadeOn(actor, undefined),
  };
};
