import {
  type Attributes,
  metrics,
  type Span,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { errorDetails } from "./shared/retry.ts";

/**
 * The instrumentation scope every span and metric of the runtime is reported under.
 */
export const TELEMETRY_SCOPE: "@bounda-dev/core" = "@bounda-dev/core";

/**
 * The attributes Bounda puts on its spans, so dashboards and queries can rely on the names.
 * `bounda.correlation_id` is on every span of a chain: a command, the events it stored, the
 * policy that reacted and the command it dispatched all carry the same value, which is how one
 * request is followed across dispatcher passes that are separate traces.
 */
export const ATTRIBUTES: {
  readonly correlationId: "bounda.correlation_id";
  readonly causationId: "bounda.causation_id";
  readonly commandType: "bounda.command.type";
  readonly aggregateType: "bounda.aggregate.type";
  readonly aggregateId: "bounda.aggregate.id";
  readonly eventId: "bounda.event.id";
  readonly eventType: "bounda.event.type";
  readonly eventCount: "bounda.event.count";
  readonly subscriber: "bounda.subscriber";
  readonly subscriberKind: "bounda.subscriber.kind";
  readonly afterPosition: "bounda.position.after";
  readonly readModel: "bounda.read_model";
  readonly projection: "bounda.projection";
  readonly policy: "bounda.policy";
  readonly process: "bounda.process";
  readonly attempt: "bounda.attempt";
  readonly outcome: "bounda.outcome";
} = {
  correlationId: "bounda.correlation_id",
  causationId: "bounda.causation_id",
  commandType: "bounda.command.type",
  aggregateType: "bounda.aggregate.type",
  aggregateId: "bounda.aggregate.id",
  eventId: "bounda.event.id",
  eventType: "bounda.event.type",
  eventCount: "bounda.event.count",
  subscriber: "bounda.subscriber",
  subscriberKind: "bounda.subscriber.kind",
  afterPosition: "bounda.position.after",
  readModel: "bounda.read_model",
  projection: "bounda.projection",
  policy: "bounda.policy",
  process: "bounda.process",
  attempt: "bounda.attempt",
  outcome: "bounda.outcome",
};

export interface TracedArgs<T> {
  readonly name: string;
  readonly attributes?: Attributes;
  readonly run: (span: Span) => Promise<T>;
}

export interface TracedFunction {
  <T>(args: TracedArgs<T>): Promise<T>;
}

/**
 * Runs `run` inside an active span. A rejection records the exception, marks the span as an
 * error with the message and rethrows; the span always ends. Without an OpenTelemetry SDK
 * registered this costs a no-op span from the API and nothing else.
 */
export const traced: TracedFunction = <T>({ name, attributes, run }: TracedArgs<T>) =>
  tracer().startActiveSpan(
    name,
    attributes === undefined ? {} : { attributes },
    async (span): Promise<T> => {
      try {
        return await run(span);
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorDetails(error).message });
        throw error;
      } finally {
        span.end();
      }
    },
  );

export interface TracerFunction {
  (): Tracer;
}

/**
 * The runtime's tracer, resolved on every call so an SDK registered after the app was created is
 * still picked up.
 */
export const tracer: TracerFunction = () => trace.getTracer(TELEMETRY_SCOPE);

export interface MeterFunction {
  (): ReturnType<typeof metrics.getMeter>;
}

/**
 * The runtime's meter, resolved on every call for the same reason as the tracer.
 */
export const meter: MeterFunction = () => metrics.getMeter(TELEMETRY_SCOPE);

/**
 * The names of the metrics the runtime records.
 */
export const METRICS: {
  readonly lag: "bounda.dispatcher.lag";
  readonly commands: "bounda.commands";
  readonly deadLetters: "bounda.dead_letters";
} = {
  lag: "bounda.dispatcher.lag",
  commands: "bounda.commands",
  deadLetters: "bounda.dead_letters",
};

export interface DeadLetteredArgs {
  readonly kind: "policy" | "process" | "command";
  readonly subscriber: string;
  readonly errorType: "terminal" | "retriable_exhausted";
}

export interface DeadLetteredFunction {
  (args: DeadLetteredArgs): void;
}

/**
 * Counts a dead letter under `bounda.dead_letters`. The counter is resolved on each call: dead
 * letters are rare, and an SDK registered late is still counted.
 */
export const deadLettered: DeadLetteredFunction = ({ kind, subscriber, errorType }) => {
  meter()
    .createCounter(METRICS.deadLetters, {
      description: "Handler runs that gave up, by kind, subscriber and error type",
      unit: "{letter}",
    })
    .add(1, {
      [ATTRIBUTES.subscriberKind]: kind,
      [ATTRIBUTES.subscriber]: subscriber,
      [ATTRIBUTES.outcome]: errorType,
    });
};
