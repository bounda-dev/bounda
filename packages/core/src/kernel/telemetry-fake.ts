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
  type Span,
  type SpanOptions,
  SpanStatusCode,
  type Tracer,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";

export interface RecordedSpan {
  readonly name: string;
  readonly attributes: Attributes;
  readonly status: { readonly code: SpanStatusCode; readonly message?: string };
  readonly exceptions: readonly string[];
  readonly ended: boolean;
}

/**
 * An event added to a span, with the span's name.
 */
export interface RecordedSpanEvent {
  readonly span: string;
  readonly name: string;
  readonly attributes: Attributes;
}

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

const recordingSpan = (
  name: string,
  attributes: Attributes,
  spans: RecordedSpan[],
  spanEvents: RecordedSpanEvent[],
): Span => {
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
    addEvent: (event: string, eventAttributes: Attributes = {}) => {
      spanEvents.push({ span: record.name, name: event, attributes: { ...eventAttributes } });
      return span;
    },
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
 * on the spans and metrics the runtime emits without an OpenTelemetry SDK.
 */
export const installFakeTelemetry: InstallFakeTelemetryFunction = () => {
  const spans: RecordedSpan[] = [];
  const spanEvents: RecordedSpanEvent[] = [];
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

  const tracer = {
    startSpan: (name: string, options?: SpanOptions) =>
      recordingSpan(name, options?.attributes ?? {}, spans, spanEvents),
    startActiveSpan: (name: string, ...rest: unknown[]) => {
      const fn = rest.at(-1) as (span: Span) => unknown;
      const options = (rest.length > 1 ? rest[0] : undefined) as SpanOptions | undefined;
      return fn(recordingSpan(name, options?.attributes ?? {}, spans, spanEvents));
    },
  } as unknown as Tracer;
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
