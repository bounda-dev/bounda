import { ROOT_CONTEXT, type Span, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { recordSpans, teeTracer } from "./span-recorder.ts";

interface Call {
  readonly span: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

// A tracer whose spans record every call made on them, and what each was started with.
const callingTracer = (label: string) => {
  const calls: Call[] = [];
  const started: unknown[][] = [];
  const spanOf = (name: string): Span => {
    const span = new Proxy({} as Span, {
      get: (_target, method: string) => {
        if (method === "spanContext") {
          return () => ({ traceId: label, spanId: name, traceFlags: 1 });
        }
        if (method === "isRecording") return () => label === "primary";
        return (...args: unknown[]) => {
          calls.push({ span: name, method, args });
          return span;
        };
      },
    });
    return span;
  };
  const tracer = {
    startSpan: (name: string, ...rest: unknown[]) => {
      started.push(["startSpan", name, ...rest]);
      return spanOf(name);
    },
    startActiveSpan: (name: string, ...rest: unknown[]) => {
      started.push(["startActiveSpan", name, ...rest.slice(0, -1)]);
      const fn = rest.at(-1) as (span: Span) => unknown;
      return fn(spanOf(name));
    },
  } as unknown as Tracer;
  return { tracer, calls, started };
};

describe("a tracer teed to a copy", () => {
  it("tells both spans of every call, answering for the primary's", () => {
    const primary = callingTracer("primary");
    const copy = callingTracer("copy");
    const tee = teeTracer(primary.tracer, copy.tracer);
    const link = { context: { traceId: "t", spanId: "s", traceFlags: 0 } };
    const error = new Error("boom");
    const returned = tee.startActiveSpan("work", { attributes: { a: 1 } }, (span) => {
      expect(span.spanContext()).toEqual({ traceId: "primary", spanId: "work", traceFlags: 1 });
      expect(span.isRecording()).toBe(true);
      const chained = [
        span.setAttribute("b", 2),
        span.setAttributes({ c: 3 }),
        span.addEvent("sent", { to: "x" }, 5),
        span.addLink(link),
        span.addLinks([link]),
        span.setStatus({ code: SpanStatusCode.ERROR, message: "m" }),
        span.updateName("renamed"),
      ];
      for (const each of chained) expect(each).toBe(span);
      span.recordException(error, 6);
      span.end(7);
      return "done";
    });
    expect(returned).toBe("done");
    const expected = [
      ["setAttribute", ["b", 2]],
      ["setAttributes", [{ c: 3 }]],
      ["addEvent", ["sent", { to: "x" }, 5]],
      ["addLink", [link]],
      ["addLinks", [[link]]],
      ["setStatus", [{ code: SpanStatusCode.ERROR, message: "m" }]],
      ["updateName", ["renamed"]],
      ["recordException", [error, 6]],
      ["end", [7]],
    ];
    for (const tracer of [primary, copy]) {
      expect(tracer.calls.map(({ method, args }) => [method, args])).toEqual(expected);
    }
    expect(primary.started).toEqual([["startActiveSpan", "work", { attributes: { a: 1 } }]]);
    expect(copy.started).toEqual([["startSpan", "work", { attributes: { a: 1 } }]]);
  });

  it("starts the primary's active span with whatever it was given, and a plain span on both", () => {
    const primary = callingTracer("primary");
    const copy = callingTracer("copy");
    const tee = teeTracer(primary.tracer, copy.tracer);
    tee.startActiveSpan("bare", (span) => span.end());
    tee.startActiveSpan("placed", {}, ROOT_CONTEXT, (span) => span.end());
    const span = tee.startSpan("plain", { attributes: { d: 4 } }, ROOT_CONTEXT);
    expect(span.isRecording()).toBe(true);
    expect(primary.started).toEqual([
      ["startActiveSpan", "bare"],
      ["startActiveSpan", "placed", {}, ROOT_CONTEXT],
      ["startSpan", "plain", { attributes: { d: 4 } }, ROOT_CONTEXT],
    ]);
    expect(copy.started).toEqual([
      ["startSpan", "bare", undefined],
      ["startSpan", "placed", {}],
      ["startSpan", "plain", { attributes: { d: 4 } }, ROOT_CONTEXT],
    ]);
  });

  it("records into the copy what the primary was told", () => {
    const primary = callingTracer("primary");
    const recording = recordSpans();
    teeTracer(primary.tracer, recording.tracer).startActiveSpan(
      "work",
      { attributes: { a: 1 } },
      (span) => {
        span.setAttribute("b", 2);
        span.addEvent("sent", { to: "x" });
        span.setStatus({ code: SpanStatusCode.ERROR, message: "m" });
        span.recordException(new Error("boom"));
        span.end();
      },
    );
    expect(recording.spans).toEqual([
      {
        name: "work",
        attributes: { a: 1, b: 2 },
        status: { code: SpanStatusCode.ERROR, message: "m" },
        exceptions: ["boom"],
        ended: true,
      },
    ]);
    expect(recording.spanEvents).toEqual([{ span: "work", name: "sent", attributes: { to: "x" } }]);
  });
});
