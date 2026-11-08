import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../.bounda/types.ts";

type Module = typeof import("../get-customer.ts");
type Row = generated.CustomerDirectoryRow;
type FieldTypes = generated.CustomerDirectoryFieldTypes;

export declare namespace Query {
  type PayloadArgs = core.PayloadArgs;
  type RepositoryArgs = core.QueryRepositoryArgs<
    core.PayloadOf<Module>,
    Row,
    unknown,
    FieldTypes
  >;
  type HandlerArgs = core.QueryHandlerArgs<
    "GetCustomer",
    core.PayloadOf<Module>,
    core.RepositoryDataOf<Module>,
    Row,
    generated.Queries,
    generated.CustomerDirectoryPorts,
    FieldTypes
  >;
}
