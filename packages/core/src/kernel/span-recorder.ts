import {
  type Attributes,
  type Span,
  type SpanOptions,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";

/**
 * A span as it stands: its attributes, status, the messages of the exceptions recorded on it, and
 * whether it ended.
 */
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
 * A tracer that keeps every span it starts in memory, as it stands.
 */
export interface SpanRecording {
  readonly tracer: Tracer;
  readonly spans: readonly RecordedSpan[];
  readonly spanEvents: readonly RecordedSpanEvent[];
}

export interface RecordSpansFunction {
  (): SpanRecording;
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

export const recordSpans: RecordSpansFunction = () => {
  const spans: RecordedSpan[] = [];
  const spanEvents: RecordedSpanEvent[] = [];
  const tracer = {
    startSpan: (name: string, options?: SpanOptions) =>
      recordingSpan(name, options?.attributes ?? {}, spans, spanEvents),
    startActiveSpan: (name: string, ...rest: unknown[]) => {
      const fn = rest.at(-1) as (span: Span) => unknown;
      const options = (rest.length > 1 ? rest[0] : undefined) as SpanOptions | undefined;
      return fn(recordingSpan(name, options?.attributes ?? {}, spans, spanEvents));
    },
  } as unknown as Tracer;
  return { tracer, spans, spanEvents };
};

export interface TeeTracerFunction {
  (primary: Tracer, copy: Tracer): Tracer;
}

const teeSpan = (primary: Span, copy: Span): Span => {
  const span: Span = {
    spanContext: () => primary.spanContext(),
    setAttribute: (key, value) => {
      primary.setAttribute(key, value);
      copy.setAttribute(key, value);
      return span;
    },
    setAttributes: (attributes) => {
      primary.setAttributes(attributes);
      copy.setAttributes(attributes);
      return span;
    },
    addEvent: (name, attributesOrTime, time) => {
      primary.addEvent(name, attributesOrTime, time);
      copy.addEvent(name, attributesOrTime, time);
      return span;
    },
    addLink: (link) => {
      primary.addLink(link);
      copy.addLink(link);
      return span;
    },
    addLinks: (links) => {
      primary.addLinks(links);
      copy.addLinks(links);
      return span;
    },
    setStatus: (status) => {
      primary.setStatus(status);
      copy.setStatus(status);
      return span;
    },
    updateName: (name) => {
      primary.updateName(name);
      copy.updateName(name);
      return span;
    },
    end: (time) => {
      primary.end(time);
      copy.end(time);
    },
    isRecording: () => primary.isRecording(),
    recordException: (exception, time) => {
      primary.recordException(exception, time);
      copy.recordException(exception, time);
    },
  };
  return span;
};

/**
 * `primary`, whose every span `copy` starts too and is told whatever `primary` is: the active
 * context holds `primary`'s span, so what the host traces under it nests as without the copy.
 */
export const teeTracer: TeeTracerFunction = (primary, copy) => ({
  startSpan: (name, options, context) =>
    teeSpan(primary.startSpan(name, options, context), copy.startSpan(name, options, context)),
  startActiveSpan: ((name: string, ...rest: unknown[]) => {
    const fn = rest.at(-1) as (span: Span) => unknown;
    const leading = rest.slice(0, -1);
    const options = leading[0] as SpanOptions | undefined;
    return Reflect.apply(primary.startActiveSpan, primary, [
      name,
      ...leading,
      (span: Span) => fn(teeSpan(span, copy.startSpan(name, options))),
    ]) as unknown;
  }) as Tracer["startActiveSpan"],
});
