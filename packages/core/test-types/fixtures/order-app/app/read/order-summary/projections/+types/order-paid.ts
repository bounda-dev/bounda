import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../.bounda/types.ts";

export declare namespace Projection {
  type Args = core.ProjectionArgs<
    core.StoredEventOf<generated.OrderEvents, "orderPaid">,
    generated.OrderSummaryRow,
    unknown
  >;
}
