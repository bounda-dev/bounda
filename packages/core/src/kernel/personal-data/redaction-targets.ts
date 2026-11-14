import { ValidationError } from "../../contracts/errors.ts";
import type { RedactedEvent } from "../../modules/bounda-events.ts";
import type { ProcessStateEventType } from "../../modules/redaction.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { PROCESS_STATE_EVENTS, processOfStream } from "../process/lifecycle.ts";
import { isRecord } from "../shared/merge-fields.ts";
import type { PersonalMarks } from "./marks.ts";

export interface RedactionMarksArgs {
  readonly aggregates: AggregatesRuntime;
  readonly processes: Pick<ProcessesRuntime, "byName">;
  readonly aggregateType: string;
  readonly type: string;
}

export interface RedactionMarksFunction {
  (args: RedactionMarksArgs): PersonalMarks | null;
}

// What an event of that stream and type marks: its payload's marks, or, for a process's lifecycle
// event that carries the state, the state's; `null` for an event that marks nothing redact
// reaches.
export const redactionMarks: RedactionMarksFunction = ({
  aggregates,
  processes,
  aggregateType,
  type,
}) => {
  const process = processOfStream(aggregateType);
  if (process !== null) {
    return PROCESS_STATE_EVENTS.includes(type as ProcessStateEventType)
      ? (processes.byName[process]?.personal ?? null)
      : null;
  }
  return aggregates.byName[aggregateType]?.eventsByType[type]?.personal ?? null;
};

export interface CheckRedactionTargetsArgs {
  readonly aggregates: AggregatesRuntime;
  readonly processes: Pick<ProcessesRuntime, "byName">;
  readonly events: unknown;
}

export interface CheckRedactionTargetsFunction {
  (args: CheckRedactionTargetsArgs): readonly RedactedEvent[];
}

const isName = (value: unknown): value is string => typeof value === "string" && value !== "";

const invalid = (path: readonly (string | number)[], message: string): ValidationError =>
  new ValidationError(`redact ${message}`, [{ path: [...path], message }]);

// The targets of `redact(person, { events })`, each event once with its fields once each, in the
// order asked. Throws `ValidationError` for none, for a target that is not one, for an event type
// that marks no personal field `redact` reaches, and for a field it does not mark `personal`.
export const checkRedactionTargets: CheckRedactionTargetsFunction = ({
  aggregates,
  processes,
  events,
}) => {
  if (!Array.isArray(events) || events.length === 0) {
    throw invalid(["events"], "needs the events whose fields to redact");
  }
  const byId = new Map<string, RedactedEvent>();
  events.forEach((target: unknown, index) => {
    const path = ["events", index];
    if (
      !isRecord(target) ||
      !isName(target.id) ||
      !isName(target.aggregateType) ||
      !isName(target.aggregateId) ||
      !isName(target.type)
    ) {
      throw invalid(path, "needs each event's aggregateType, aggregateId, type and id");
    }
    const { id, aggregateType, aggregateId, type, fields } = target;
    if (!Array.isArray(fields) || fields.length === 0 || !fields.every(isName)) {
      throw invalid([...path, "fields"], "needs the fields of each event to redact");
    }
    const marks = redactionMarks({ aggregates, processes, aggregateType, type });
    if (marks === null || marks.fields.length === 0) {
      throw invalid(path, `cannot reach ${aggregateType}.${type}: it marks no field personal`);
    }
    const unmarked = fields.find((field) => !marks.fields.includes(field));
    if (unmarked !== undefined) {
      throw invalid(
        [...path, "fields"],
        `cannot reach "${unmarked}" of ${aggregateType}.${type}: it is not marked personal`,
      );
    }
    const known = byId.get(id);
    if (
      known !== undefined &&
      (known.aggregateType !== aggregateType ||
        known.aggregateId !== aggregateId ||
        known.type !== type)
    ) {
      throw invalid(path, `names the event ${id} twice, as two different events`);
    }
    byId.set(id, {
      id,
      aggregateType,
      aggregateId,
      type,
      fields: [...new Set([...(known?.fields ?? []), ...fields])],
    });
  });
  return [...byId.values()];
};
