import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../.bounda/types.ts";

type Module = typeof import("../get-order.ts");
type Row = generated.OrderSummaryRow;

export declare namespace Query {
  type PayloadArgs = core.PayloadArgs;
  type RepositoryArgs = core.QueryRepositoryArgs<
    core.PayloadOf<Module>,
    Row,
    unknown
  >;
  type HandlerArgs = core.QueryHandlerArgs<
    "GetOrder",
    core.PayloadOf<Module>,
    core.RepositoryDataOf<Module>,
    Row,
    generated.Queries
  >;
}
