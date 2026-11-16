import {
  type Attributes,
  type Context,
  context,
  type Meter,
  type MeterProvider,
  type MetricOptions,
  metrics,
  type ObservableCallback,
  type ObservableGauge,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";
import { type RecordedSpan, type RecordedSpanEvent, recordSpans } from "./span-recorder.ts";

export type { RecordedSpan, RecordedSpanEvent };

/**
 * One value a counter added, a histogram or gauge recorded, or an observable callback observed.
 */
export interface RecordedCount {
  readonly metric: string;
  readonly value: number;
  readonly attributes: Attributes;
}

export interface RecordedInstrument {
  readonly metric: string;
  readonly description: string;
  readonly unit: string;
}

export interface FakeTelemetry {
  /**
   * Whether its providers took the place of the global ones: not when another was registered.
   */
  readonly registered: boolean;
  readonly spans: readonly RecordedSpan[];
  readonly spanEvents: readonly RecordedSpanEvent[];
  readonly counts: readonly RecordedCount[];
  readonly instruments: readonly RecordedInstrument[];
  /**
   * Runs every observable callback registered so far and returns what they observed.
   */
  observe(): Promise<readonly RecordedCount[]>;
  /**
   * Unregisters the fake providers. Call it when the test ends.
   */
  restore(): void;
}

export interface InstallFakeTelemetryFunction {
  (): FakeTelemetry;
}

/**
 * Registers a tracer provider and a meter provider that record into memory, so tests can assert
 * on the spans and metrics the runtime emits without an OpenTelemetry SDK.
 */
export const installFakeTelemetry: InstallFakeTelemetryFunction = () => {
  const { tracer, spans, spanEvents } = recordSpans();
  const counts: RecordedCount[] = [];
  const instruments: RecordedInstrument[] = [];
  const callbacks = new Map<string, ObservableCallback>();
  const describe = (metric: string, options?: MetricOptions): void => {
    instruments.push({
      metric,
      description: options?.description ?? "",
      unit: options?.unit ?? "",
    });
  };

  const tracerProvider: TracerProvider = { getTracer: () => tracer };

  const counter = (metric: string, options?: MetricOptions) => {
    describe(metric, options);
    return {
      add: (value: number, attributes: Attributes = {}) => {
        counts.push({ metric, value, attributes });
      },
    };
  };
  const gauge = (metric: string, options?: MetricOptions): ObservableGauge => {
    describe(metric, options);
    return {
      addCallback: (callback: ObservableCallback) => {
        callbacks.set(metric, callback);
      },
      removeCallback: () => {
        callbacks.delete(metric);
      },
    } as unknown as ObservableGauge;
  };
  const meter = {
    createCounter: counter,
    createUpDownCounter: counter,
    createHistogram: (metric: string, options?: MetricOptions) => {
      describe(metric, options);
      return {
        record: (value: number, attributes: Attributes = {}) => {
          counts.push({ metric, value, attributes });
        },
      };
    },
    createObservableGauge: gauge,
    createObservableCounter: gauge,
    createObservableUpDownCounter: gauge,
    createGauge: (metric: string) => ({
      record: (value: number, attributes: Attributes = {}) => {
        counts.push({ metric, value, attributes });
      },
    }),
    addBatchObservableCallback: () => undefined,
    removeBatchObservableCallback: () => undefined,
  } as unknown as Meter;
  const meterProvider: MeterProvider = { getMeter: () => meter };

  // OpenTelemetry keeps the first provider registered; the meter's only goes in with the tracer's.
  const registered = trace.setGlobalTracerProvider(tracerProvider);
  if (registered) metrics.setGlobalMeterProvider(meterProvider);

  return {
    registered,
    spans,
    spanEvents,
    counts,
    instruments,
    observe: async () => {
      const observed: RecordedCount[] = [];
      for (const [metric, callback] of callbacks) {
        await callback({
          observe: (value: number, attributes: Attributes = {}) => {
            observed.push({ metric, value, attributes });
          },
        });
      }
      return observed;
    },
    restore: () => {
      trace.disable();
      metrics.disable();
      context.disable();
    },
  };
};

export type { Context };
