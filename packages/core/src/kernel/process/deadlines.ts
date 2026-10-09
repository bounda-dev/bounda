import { z } from "zod";
import { parseDuration } from "../../contracts/duration.ts";
import { type Instant, instantSchema } from "../../contracts/instant.ts";
import type {
  DeadlineFieldSchema,
  InstantFieldSchema,
  ProcessAfterFunction,
  ProcessStateArgs,
} from "../../modules/process.ts";

/**
 * The deadline every process has: `config.timeout` after it started. Its handler is
 * `at-timeout.ts`, and reaching it ends the process as `timed_out`, but for the follow-ups its
 * commands cause.
 */
export const TIMEOUT_DEADLINE: "timeout" = "timeout";

/**
 * The command type the scheduler holds for the next deadline of a process instance. Routed to the
 * process runner, never to a user command handler.
 */
export const PROCESS_DEADLINE_COMMAND: "bounda.ProcessDeadline" = "bounda.ProcessDeadline";

/**
 * What the scheduler holds for a process instance. `field` and `at` say which deadline the entry
 * was scheduled for; the runner works out which one is due from the instance when it runs.
 */
export interface ProcessDeadlinePayload {
  readonly process: string;
  readonly aggregateId: string;
  readonly field: string;
  readonly at: string;
}

const deadlineSchemas = new WeakSet<object>();

const instant = (): InstantFieldSchema => instantSchema.nullable().default(null);

const deadline = (): DeadlineFieldSchema => {
  const schema = instant();
  deadlineSchemas.add(schema);
  return schema as DeadlineFieldSchema;
};

/**
 * What a process `state` schema function receives.
 */
export const processStateArgs: ProcessStateArgs = { z, deadline, instant };

export interface DeadlineFieldsOfFunction {
  (schema: z.ZodType | null): readonly string[];
}

export const deadlineFieldsOf: DeadlineFieldsOfFunction = (schema) =>
  schema instanceof z.ZodObject
    ? Object.entries(schema.shape)
        .filter(([, field]) => deadlineSchemas.has(field))
        .map(([name]) => name)
        .sort()
    : [];

export interface AfterFromFunction {
  (base: string): ProcessAfterFunction;
}

/**
 * The `after` a handler receives, counting from `base`: the time of the event or of the deadline
 * that triggered it.
 */
export const afterFrom: AfterFromFunction = (base) => (delay) =>
  new Date(Date.parse(base) + parseDuration(delay)).toISOString() as Instant;

export interface Deadline {
  readonly field: string;
  readonly at: string;
}

export interface DeadlineAtFunction {
  (state: object, field: string): string | null;
}

export const deadlineAt: DeadlineAtFunction = (state, field) => {
  const at = (state as Readonly<Record<string, unknown>>)[field];
  return typeof at === "string" ? at : null;
};

export interface ReachedKeyFunction {
  (deadline: Deadline): string;
}

/**
 * Identifies a deadline at a moment, whatever the precision the moment was written with.
 */
export const reachedKey: ReachedKeyFunction = ({ field, at }) => `${field}@${Date.parse(at)}`;

export interface NextDeadlineArgs {
  readonly fields: readonly string[];
  readonly state: object;
  readonly timeoutAt: string | null;
  readonly reached: ReadonlySet<string>;
}

export interface NextDeadlineFunction {
  (args: NextDeadlineArgs): Deadline | null;
}

/**
 * The deadline an instance reaches next: the earliest set moment, among its deadline fields and
 * its timeout, that it has not reached yet; the field name breaks a tie.
 */
export const nextDeadline: NextDeadlineFunction = ({ fields, state, timeoutAt, reached }) => {
  const candidates: Deadline[] = [
    ...fields.flatMap((field) => {
      const at = deadlineAt(state, field);
      return at === null ? [] : [{ field, at }];
    }),
    ...(timeoutAt === null ? [] : [{ field: TIMEOUT_DEADLINE, at: timeoutAt }]),
  ].filter((candidate) => !reached.has(reachedKey(candidate)));
  candidates.sort(
    (a, b) =>
      Date.parse(a.at) - Date.parse(b.at) || (a.field < b.field ? -1 : a.field > b.field ? 1 : 0),
  );
  return candidates[0] ?? null;
};
