import { metrics, trace } from "@opentelemetry/api";
import {
  installFakeTelemetry,
  type RecordedSpan,
  type RecordedSpanEvent,
} from "../kernel/telemetry-fake.ts";

export type { RecordedSpan, RecordedSpanEvent };

/**
 * The spans the runtime started since `recordTelemetry()`, as they stand now.
 */
export interface TelemetryRecording {
  readonly spans: readonly RecordedSpan[];
  readonly spanEvents: readonly RecordedSpanEvent[];
  /**
   * Stops recording and unregisters the global tracer and meter providers it registered. Call it
   * when the test ends.
   */
  stop(): void;
}

export interface RecordTelemetryFunction {
  (): TelemetryRecording;
}

/**
 * Records every span the runtime starts, with its attributes, status, exceptions and events, by
 * registering a global OpenTelemetry tracer provider and meter provider: for `expectForgotten`'s
 * `telemetry`, or to assert on spans. Needs no SDK. Throws when a tracer provider is registered
 * already, an SDK's or a recording not stopped, since OpenTelemetry keeps the first and nothing
 * would be recorded.
 */
export const recordTelemetry: RecordTelemetryFunction = () => {
  const fake = installFakeTelemetry();
  if (!fake.registered) {
    throw new Error(
      "recordTelemetry could not register its tracer provider: another one is registered globally, an SDK's or a recording not stopped",
    );
  }
  return {
    spans: fake.spans,
    spanEvents: fake.spanEvents,
    stop: () => {
      trace.disable();
      metrics.disable();
    },
  };
};
