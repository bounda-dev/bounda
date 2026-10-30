import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../.bounda/types.ts";

type Module = typeof import("../get-customer.ts");
type Row = generated.CustomerDirectoryRow;

export declare namespace Query {
  type PayloadArgs = core.PayloadArgs;
  type RepositoryArgs = core.QueryRepositoryArgs<
    core.PayloadOf<Module>,
    Row,
    unknown
  >;
  type HandlerArgs = core.QueryHandlerArgs<
    "GetCustomer",
    core.PayloadOf<Module>,
    core.RepositoryDataOf<Module>,
    Row,
    generated.Queries,
    generated.CustomerDirectoryPorts
  >;
}
