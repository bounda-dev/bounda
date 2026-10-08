import type { ReadClient, Table } from "../adapter/ports/table.ts";
import type { Query } from "../contracts/query.ts";
import type { EmptyPayload, PayloadFunction } from "./payload.ts";

/**
 * The shape of a query module: an optional `payload`, an optional `repository` that reads the
 * storage, and a `handler` that shapes the result.
 */
export interface QueryModule {
  readonly payload?: PayloadFunction;
  readonly repository?: (args: never) => unknown;
  readonly handler: (args: never) => unknown;
}

/**
 * Arguments of `repository`: the payload fields spread at the top level, the typed read client
 * and the typed table.
 */
export type QueryRepositoryArgs<Payload, Row, Raw = unknown> = Readonly<Payload> & {
  readonly client: ReadClient<Row, Raw>;
  readonly table: Table<Row>;
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
 * is the typed facade of every query in the app, so a handler can compose other queries. Two
 * queries whose results depend on each other do not compile; that is a genuine cycle.
 */
export type QueryHandlerArgs<
  Type extends string,
  Payload,
  RepositoryData,
  Row,
  Queries,
  Ports extends object = EmptyPayload,
> = {
  readonly query: Query<Type, Payload>;
  readonly repositoryData: RepositoryData;
  readonly table: Table<Row>;
  readonly queries: Queries;
} & Readonly<Ports>;

/**
 * What a query resolves to: the awaited return type of its `handler`.
 */
export type QueryResultOf<Module> = Module extends {
  readonly handler: (args: never) => infer Result;
}
  ? Awaited<Result>
  : never;
