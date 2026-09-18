import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../../generated/types.ts";

export declare namespace Projection {
  type Args = core.ProjectionArgs<
    core.StoredEventOf<generated.OrderEvents, "orderPaid">,
    generated.OrderSummaryRow,
    unknown
  >;
}
