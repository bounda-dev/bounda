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
   * Stops recording and unregisters the global tracer and meter providers. Call it when the test
   * ends.
   */
  stop(): void;
}

export interface RecordTelemetryFunction {
  (): TelemetryRecording;
}

/**
 * Records every span the runtime starts, with its attributes, status, exceptions and events, by
 * registering a global OpenTelemetry tracer provider, and a meter provider, in place of any other:
 * for `expectForgotten`'s `telemetry`, or to assert on spans. Needs no SDK.
 */
export const recordTelemetry: RecordTelemetryFunction = () => {
  const fake = installFakeTelemetry();
  return { spans: fake.spans, spanEvents: fake.spanEvents, stop: fake.restore };
};
