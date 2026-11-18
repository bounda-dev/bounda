import type { RestrictionView } from "../../adapter/storage/restricted-persons.ts";
import type { ErrorText } from "../../config/types.ts";
import { NotFoundError } from "../../contracts/errors.ts";
import type { RestrictionBasis } from "../../modules/personal-data.ts";
import type { QueryOptions } from "../../modules/query.ts";
import { validatePayload } from "../command/validate.ts";
import { type RecordAccess, recorded } from "../personal-data/access.ts";
import { checkIncludeRestricted, restrictionViewOf } from "../personal-data/restricted-reads.ts";
import type { ModulePorts } from "../ports/ports.ts";
import type { SealingSource } from "../projection/runner.ts";
import { projectionSubscriberName } from "../projection/runner.ts";
import type { ReadModelRuntime, ReadModelsRuntime } from "../read-model/build-read-models.ts";
import { createSealingKeyRing } from "../read-model/sealing-keys.ts";
import { lazyTableIndexer } from "../read-model/table-indexer.ts";
import type { Disclosures } from "../recipients/gate.ts";
import { isRecord } from "../shared/merge-fields.ts";
import { runtimeText } from "../shared/runtime-text.ts";
import { withPorts } from "../shared/with-ports.ts";
import { ATTRIBUTES, actorAttribute, type TracerFunction, traced } from "../telemetry.ts";
import { checkPayloadFields, type QueriesRuntime } from "./build-queries.ts";
import { reading } from "./reading.ts";

// The categories of the fields a read model marks `.personal()`.
const categoriesOf = (readModel: ReadModelRuntime): readonly string[] => [
  ...new Set(
    Object.values(readModel.fields).flatMap((field) =>
      field.category === null ? [] : [field.category],
    ),
  ),
];

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
   * The keys and blind indexes the read models' values are opened and looked up with.
   */
  readonly sealing: SealingSource;
  /**
   * What each read model's query handlers receive; `repository` reads the storage and gets none.
   */
  readonly ports: ModulePorts;
  readonly recordAccess: RecordAccess;
  readonly errorText: ErrorText;
  readonly tracer: TracerFunction;
  readonly disclosures?: Disclosures | undefined;
  /**
   * Where a read model's projection stands, as the dispatcher's lag says: its checkpoint, or past
   * the events after it that it does not handle, which its rows reflect as they are.
   */
  readonly standing: (subscriber: string) => Promise<number>;
  /**
   * Throw to refuse what a query of the read model would hand out: `before` it reads, and `after`
   * it read, once its handler returns and, for a handler with ports, before the handler runs.
   */
  readonly vouch?: QueryVouch;
}

export interface QueryVouch {
  before(readModel: string): Promise<void>;
  after(readModel: string): Promise<void>;
}

export interface CreateQueryRunnerFunction {
  (args: CreateQueryRunnerArgs): QueryRunner;
}

export const createQueryRunner: CreateQueryRunnerFunction = ({
  queries,
  readModels,
  sealing,
  ports,
  recordAccess,
  errorText,
  tracer,
  disclosures,
  standing,
  vouch,
}) => {
  // The stores of a read model as a query reads them: sealed values opened, with the keys fetched
  // for this query alone, and, with a field marked `.person()`, the rows of restricted persons
  // left out.
  const storesOf = (readModel: ReadModelRuntime, view: RestrictionView) =>
    reading({
      storage: readModel.storage,
      layout: readModel.layout,
      keys: createSealingKeyRing({ keys: sealing.keys, fetching: true }),
      indexer: lazyTableIndexer({
        indexer: sealing.indexer,
        readModel: readModel.name,
        checkpoints: readModel.storage.checkpointStore,
        table: readModel.storage.table,
      }),
      view,
    });
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
      tracer,
      errorText,
      name: `bounda.query ${type}`,
      attributes: {
        [ATTRIBUTES.queryType]: type,
        [ATTRIBUTES.readModel]: query.readModel,
        ...actorAttribute(actor),
      },
      run: async () => {
        const parsed = validatePayload({ schema: query.schema, payload, subject: `query ${type}` });
        await vouch?.before(query.readModel);
        const stores = storesOf(readModel, restrictionViewOf(includeRestricted));
        const { table, client } = stores;
        if (query.repository !== null && isRecord(parsed)) {
          checkPayloadFields(
            `readModels.${query.readModel}.queries.${query.key}`,
            Object.keys(parsed),
          );
        }
        // The rows read reflect the stream through where the projection stands, read first: a
        // change of a person past it, which the rows may not show yet, refuses a disclosure.
        const fence =
          disclosures === undefined || !disclosures.tells(query.readModel)
            ? undefined
            : await standing(projectionSubscriberName(query.readModel));
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
          const readModelPorts =
            disclosures?.bind(query.readModel, ports[query.readModel] ?? {}, {
              opened: () =>
                [...stores.persons].flatMap((person) =>
                  categoriesOf(readModel).map((category) => ({
                    person,
                    fingerprint: null,
                    category,
                    fence,
                  })),
                ),
              basis: includeRestricted,
              handler: query.key,
              actor,
            }) ??
            ports[query.readModel] ??
            {};
          // A handler that can send what it reads out waits for its reads to be vouched for.
          if (Object.keys(readModelPorts).length > 0) await vouch?.after(query.readModel);
          const answer = await query.handler(
            Object.keys(readModelPorts).length === 0 ? args : withPorts(readModelPorts, args),
          );
          await vouch?.after(query.readModel);
          return answer;
        };
        // Recorded once its handler settles, before its result or error is handed out, naming
        // the persons of the rows it read: a handler may reshape what it read, so its result
        // cannot tell whose data it holds. A read model with no field marked `.personal()` is
        // recorded only when restricted rows were asked for.
        if (
          readModel.personalData === null ||
          (includeRestricted === undefined && readModel.personalData.personal.length === 0)
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
                      persons: new Set([
                        ...(await readModel.storage.restricted.among(
                          stores.persons,
                          "unrestricted",
                        )),
                        ...stores.retained,
                      ]),
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
