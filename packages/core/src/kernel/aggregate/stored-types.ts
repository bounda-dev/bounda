import { codePointOrder } from "../../adapter/sql/order.ts";
import type { StoredEventType } from "../../adapter/storage/event-store.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { BOUNDA_AGGREGATE, BOUNDA_EVENTS } from "../../modules/bounda-events.ts";
import type { Registry } from "../../modules/registry.ts";
import { PROCESS_EVENTS, processAggregateType } from "../process/lifecycle.ts";
import { SCHEDULED_COMMAND_FAILED_EVENT } from "../system-events.ts";
import type { AggregatesRuntime } from "./runtime.ts";

export interface CheckStoredTypesArgs {
  readonly types: readonly StoredEventType[];
  readonly aggregates: AggregatesRuntime;
  /**
   * Every process of the registry, `<aggregate>.<process>`.
   */
  readonly processNames: ReadonlySet<string>;
}

export interface CheckStoredTypesFunction {
  (args: CheckStoredTypesArgs): void;
}

// The runtime's own events are written at this version, whatever the code.
const RUNTIME_SCHEMA_VERSION = 1;

const PROCESS_PREFIX = processAggregateType("");

const runtimeEvents: ReadonlySet<string> = new Set(Object.values(BOUNDA_EVENTS));
const processEvents: ReadonlySet<string> = new Set(Object.values(PROCESS_EVENTS));

const ahead = (qualified: string, stored: number, known: number): string =>
  `${qualified} was written with schema version ${stored}, past the ${known} this code knows: newer code wrote it. Deploy that code; roll forward, never back`;

// What is wrong with one stored type, or `null` when this code reads it.
const problemOf = (
  { aggregateType, type, schemaVersion }: StoredEventType,
  { aggregates, processNames }: Omit<CheckStoredTypesArgs, "types">,
): string | null => {
  const qualified = `${aggregateType}.${type}`;
  const runtimeVersion = (): string | null =>
    schemaVersion > RUNTIME_SCHEMA_VERSION
      ? ahead(qualified, schemaVersion, RUNTIME_SCHEMA_VERSION)
      : null;
  if (aggregateType === BOUNDA_AGGREGATE) {
    return runtimeEvents.has(type)
      ? runtimeVersion()
      : `${qualified} is no event of the runtime: newer Bounda wrote it. Upgrade @bounda-dev/core`;
  }
  if (aggregateType.startsWith(PROCESS_PREFIX)) {
    const process = aggregateType.slice(PROCESS_PREFIX.length);
    if (!processNames.has(process)) {
      return `The store holds instances of the process "${process}", which the app no longer has. Bring its module back, or rename it back`;
    }
    return processEvents.has(type)
      ? runtimeVersion()
      : `${qualified} is no process event: newer Bounda wrote it. Upgrade @bounda-dev/core`;
  }
  const aggregate = aggregates.byName[aggregateType];
  if (aggregate === undefined) {
    return `The store holds events of the aggregate "${aggregateType}", which the app no longer has. Bring app/domain/${aggregateType} back, or rename it back`;
  }
  if (type === SCHEDULED_COMMAND_FAILED_EVENT) return runtimeVersion();
  const runtime = aggregate.eventsByType[type];
  if (runtime === undefined) {
    return `The store holds ${qualified} events, and no module of the aggregate is that event. Bring its module back, or rename it back`;
  }
  return schemaVersion > runtime.schemaVersion
    ? ahead(qualified, schemaVersion, runtime.schemaVersion)
    : null;
};

/**
 * Checks every kind of event the store holds against this code, so one it cannot read refuses
 * the boot instead of failing the first command, or a projection skipping it in silence. Throws
 * one `ConfigurationError` naming every problem.
 */
export const checkStoredTypes: CheckStoredTypesFunction = ({ types, ...app }) => {
  const problems = [...types]
    .sort(
      (a, b) =>
        codePointOrder(a.aggregateType, b.aggregateType) ||
        codePointOrder(a.type, b.type) ||
        a.schemaVersion - b.schemaVersion,
    )
    .map((stored) => problemOf(stored, app))
    .filter((problem) => problem !== null);
  if (problems.length === 0) return;
  throw new ConfigurationError(
    `The store holds events this code cannot read:\n${[...new Set(problems)].map((problem) => `- ${problem}`).join("\n")}`,
  );
};

export interface ProcessNamesOfFunction {
  (registry: Registry): ReadonlySet<string>;
}

export const processNamesOf: ProcessNamesOfFunction = (registry) =>
  new Set(
    Object.entries(registry.aggregates).flatMap(([aggregate, entry]) =>
      Object.keys(entry.processes).map((key) => `${aggregate}.${key}`),
    ),
  );
