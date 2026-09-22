import {
  type Attributes,
  type Context,
  context,
  type Meter,
  type MeterProvider,
  metrics,
  type ObservableCallback,
  type ObservableGauge,
  type Span,
  type SpanOptions,
  SpanStatusCode,
  type Tracer,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";

/**
 * What the fake tracer remembers about one span.
 */
export interface RecordedSpan {
  readonly name: string;
  readonly attributes: Attributes;
  readonly status: { readonly code: SpanStatusCode; readonly message?: string };
  readonly exceptions: readonly string[];
  readonly ended: boolean;
}

/**
 * What the fake meter remembers about one counter increment.
 */
export interface RecordedCount {
  readonly metric: string;
  readonly value: number;
  readonly attributes: Attributes;
}

export interface FakeTelemetry {
  readonly spans: readonly RecordedSpan[];
  readonly counts: readonly RecordedCount[];
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

const recordingSpan = (name: string, attributes: Attributes, spans: RecordedSpan[]): Span => {
  const record = {
    name,
    attributes: { ...attributes },
    status: { code: SpanStatusCode.UNSET } as RecordedSpan["status"],
    exceptions: [] as string[],
    ended: false,
  };
  const index = spans.push(record) - 1;
  const commit = (): void => {
    spans[index] = {
      name: record.name,
      attributes: { ...record.attributes },
      status: record.status,
      exceptions: [...record.exceptions],
      ended: record.ended,
    };
  };
  commit();
  const span = {
    spanContext: () => ({ traceId: "0", spanId: "0", traceFlags: 0 }),
    setAttribute: (key: string, value: unknown) => {
      record.attributes[key] = value as Attributes[string];
      commit();
      return span;
    },
    setAttributes: (values: Attributes) => {
      Object.assign(record.attributes, values);
      commit();
      return span;
    },
    addEvent: () => span,
    addLink: () => span,
    addLinks: () => span,
    setStatus: (status: RecordedSpan["status"]) => {
      record.status = status;
      commit();
      return span;
    },
    updateName: (next: string) => {
      record.name = next;
      commit();
      return span;
    },
    end: () => {
      record.ended = true;
      commit();
    },
    isRecording: () => true,
    recordException: (error: unknown) => {
      record.exceptions.push(error instanceof Error ? error.message : String(error));
      commit();
    },
  } as unknown as Span;
  return span;
};

/**
 * Registers a tracer provider and a meter provider that record into memory, so tests can assert
 * on the spans and metrics the runtime emits without an OpenTelemetry SDK. Returns the recording
 * and a `restore` that unregisters both.
 */
export const installFakeTelemetry: InstallFakeTelemetryFunction = () => {
  const spans: RecordedSpan[] = [];
  const counts: RecordedCount[] = [];
  const callbacks = new Map<string, ObservableCallback>();

  const tracer = {
    startSpan: (name: string, options?: SpanOptions) =>
      recordingSpan(name, options?.attributes ?? {}, spans),
    startActiveSpan: (name: string, ...rest: unknown[]) => {
      const fn = rest.at(-1) as (span: Span) => unknown;
      const options = (rest.length > 1 ? rest[0] : undefined) as SpanOptions | undefined;
      return fn(recordingSpan(name, options?.attributes ?? {}, spans));
    },
  } as unknown as Tracer;
  const tracerProvider: TracerProvider = { getTracer: () => tracer };

  const counter = (metric: string) => ({
    add: (value: number, attributes: Attributes = {}) => {
      counts.push({ metric, value, attributes });
    },
  });
  const gauge = (metric: string): ObservableGauge =>
    ({
      addCallback: (callback: ObservableCallback) => {
        callbacks.set(metric, callback);
      },
      removeCallback: () => {
        callbacks.delete(metric);
      },
    }) as unknown as ObservableGauge;
  const meter = {
    createCounter: counter,
    createUpDownCounter: counter,
    createHistogram: (metric: string) => ({
      record: (value: number, attributes: Attributes = {}) => {
        counts.push({ metric, value, attributes });
      },
    }),
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

  trace.setGlobalTracerProvider(tracerProvider);
  metrics.setGlobalMeterProvider(meterProvider);

  return {
    spans,
    counts,
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
