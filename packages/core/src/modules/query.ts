import type { FieldTypes, FieldTypesOfRow, ReadClient, Table } from "../adapter/storage/table.ts";
import type { Query } from "../contracts/query.ts";
import type { EmptyPayload, PayloadFunction } from "./payload.ts";

export interface QueryModule {
  readonly payload?: PayloadFunction;
  readonly repository?: (args: never) => unknown;
  readonly handler: (args: never) => unknown;
}

/**
 * Arguments of `repository`: the payload fields spread at the top level, the typed read client,
 * the typed table, and the `actor` of the client that asked (`as`), `undefined` for one that names
 * nobody, so a repository can read only what that actor may see. `Types` is how the view stores
 * each field, which decides what the table filters it by.
 */
export type QueryRepositoryArgs<
  Payload,
  Row,
  Raw = unknown,
  Types extends FieldTypes<Row> = FieldTypesOfRow<Row>,
> = Readonly<Payload> & {
  readonly client: ReadClient<Row, Raw>;
  readonly table: Table<Row, Types>;
  readonly actor: string | undefined;
};

/**
 * What `repository` resolved to, or `undefined` when the module has no repository.
 */
export type RepositoryDataOf<Module> = Module extends {
  readonly repository: (args: never) => infer Result;
}
  ? Awaited<Result>
  : undefined;

/**
 * Arguments of a query `handler`, with the read model's ports spread at the top level. `queries`
 * is the typed facade of every query in the app, so a handler can compose other queries, which
 * run as the same actor. `actor` is that of the client that asked (`as`), `undefined` for one that
 * names nobody. Two queries whose results depend on each other do not compile; that is a genuine
 * cycle. `Types` is how the view stores each field, which decides what the table filters it by.
 */
export type QueryHandlerArgs<
  Type extends string,
  Payload,
  RepositoryData,
  Row,
  Queries,
  Ports extends object = EmptyPayload,
  Types extends FieldTypes<Row> = FieldTypesOfRow<Row>,
> = {
  readonly query: Query<Type, Payload>;
  readonly repositoryData: RepositoryData;
  readonly table: Table<Row, Types>;
  readonly queries: Queries;
  readonly actor: string | undefined;
} & Readonly<Ports>;

/**
 * What a query resolves to: the awaited return type of its `handler`.
 */
export type QueryResultOf<Module> = Module extends {
  readonly handler: (args: never) => infer Result;
}
  ? Awaited<Result>
  : never;
