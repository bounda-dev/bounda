import type { NewCommand } from "../../contracts/command.ts";
import type { CausationContext, EventMetadata } from "../../contracts/metadata.ts";
import type { PendingEvent } from "../ports/event-store.ts";

/**
 * Metadata for events built in contract tests.
 */
export const testMetadata: EventMetadata = {
  correlationId: "corr-1",
  causationId: "cmd-1",
  depth: 0,
  schemaVersion: 1,
  system: false,
};

/**
 * Causal context for commands scheduled in contract tests.
 */
export const testContext: CausationContext = {
  correlationId: "corr-1",
  causationId: "cmd-1",
  depth: 0,
};

export interface PendingEventArgs {
  readonly aggregateType?: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly type?: string;
  readonly payload?: unknown;
  readonly id?: string;
}

export interface PendingEventFunction {
  (args: PendingEventArgs): PendingEvent;
}

/**
 * Builds a pending event with sensible defaults for contract tests.
 */
export const pendingEvent: PendingEventFunction = ({
  aggregateType = "order",
  aggregateId,
  version,
  type = "OrderPlaced",
  payload = { total: version },
  id = `${aggregateType}-${aggregateId}-${version}`,
}) => ({
  id,
  aggregateType,
  aggregateId,
  version,
  type,
  payload,
  timestamp: "2026-01-01T00:00:00.000Z",
  metadata: testMetadata,
});

export interface TestCommandFunction {
  (aggregateId: string, payload?: unknown): NewCommand;
}

/**
 * Builds a command for scheduler contract tests.
 */
export const testCommand: TestCommandFunction = (aggregateId, payload = {}) => ({
  type: "RemindCustomer",
  aggregateId,
  payload,
});
