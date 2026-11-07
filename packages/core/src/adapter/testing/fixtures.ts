import type { NewCommand, StoredDispatch } from "../../contracts/command.ts";
import type { CausationContext, EventMetadata } from "../../contracts/metadata.ts";
import type { NewDeadLetter } from "../storage/dead-letter-store.ts";
import type { PendingEvent } from "../storage/event-store.ts";
import type { KeyedPerson, SealedValue, StoredPersonalKey } from "../storage/personal-key-store.ts";

/**
 * Metadata for events built in contract tests.
 */
export const testMetadata: EventMetadata = {
  correlationId: "corr-1",
  causationId: "evt-0",
  commandId: "cmd-1",
  actor: "user-1",
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
  actor: "user-1",
  depth: 0,
};

export interface PendingEventArgs {
  readonly aggregateType?: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly type?: string;
  readonly payload?: unknown;
  readonly id?: string;
  readonly person?: string | null;
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
  person = null,
}) => ({
  id,
  aggregateType,
  aggregateId,
  version,
  type,
  payload,
  timestamp: "2026-01-01T00:00:00.000Z",
  metadata: testMetadata,
  person,
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

export interface TestDeadLetterFunction {
  (id: string): NewDeadLetter;
}

export const testDeadLetter: TestDeadLetterFunction = (id) => ({
  id,
  kind: "policy",
  handler: "order.p",
  eventId: "e1",
  eventType: "OrderPlaced",
  aggregateType: "order",
  aggregateId: "1",
  person: null,
  errorType: "terminal",
  errorName: "Error",
  errorMessage: "boom",
  attempts: 1,
  firstFailedAt: "2026-01-01T00:00:00.000Z",
  lastFailedAt: "2026-01-01T00:00:00.000Z",
});

export interface TestOutcomeFunction {
  (aggregateId: string): StoredDispatch;
}

/**
 * What a stored command answered, for idempotency store contract tests.
 */
export const testOutcome: TestOutcomeFunction = (aggregateId) => ({
  scheduled: false,
  aggregateType: "order",
  aggregateId,
  version: 1,
  eventIds: [`order-${aggregateId}-1`],
  eventTypes: ["OrderPlaced"],
  position: 1,
});

export interface TestPersonalKeyFunction {
  (name: string): StoredPersonalKey;
}

/**
 * A personal key and its fingerprint, both named after `name`, for contract tests.
 */
export const testPersonalKey: TestPersonalKeyFunction = (name) => ({
  key: `k-${name}`,
  fingerprint: `f-${name}`,
});

export interface TestSealedValueFunction {
  (person: string, key: string): SealedValue;
}

/**
 * A value sealed under `testPersonalKey(key)` as a store sees it: an envelope it keeps without
 * opening, naming `person` and the key's fingerprint.
 */
export const testSealedValue: TestSealedValueFunction = (person, key) => ({
  $personal: {
    person,
    key: testPersonalKey(key).fingerprint,
    iv: `iv-${person}`,
    data: `data-${person}`,
  },
});

export interface TestKeyedPersonFunction {
  (person: string, key: string | null): KeyedPerson;
}

/**
 * A person read under the key `testPersonalKey(key)`, or under none for `null`.
 */
export const testKeyedPerson: TestKeyedPersonFunction = (person, key) => ({
  person,
  fingerprint: key === null ? null : testPersonalKey(key).fingerprint,
});
