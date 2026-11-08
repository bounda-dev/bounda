import type {
  BoundaApp,
  ForgetAgainEntry,
  ForgetAgainOptions,
  RebuildReadModelArgs,
} from "@bounda-dev/core";
import { type CreateConsoleLoggerArgs, createConsoleLogger } from "@bounda-dev/core/node";
import { describe, expectTypeOf, it } from "vitest";
import type { registry } from "./fixtures/order-app/.bounda/registry.ts";

type App = BoundaApp<typeof registry>;

// The shape of Node's process.stderr that matters here: write answers whether it was flushed.
declare const stderr: { write(text: string, callback?: () => void): boolean; readonly fd: 2 };

describe("naming who runs an operation", () => {
  it("forgetAgain takes who acts as an optional id", () => {
    expectTypeOf<App["forgetAgain"]>().parameter(0).toEqualTypeOf<readonly ForgetAgainEntry[]>();
    expectTypeOf<App["forgetAgain"]>().parameter(1).toEqualTypeOf<ForgetAgainOptions | undefined>();
    expectTypeOf<ForgetAgainOptions>().toEqualTypeOf<{ readonly actor?: string }>();
  });

  it("rebuildReadModel takes who runs it as an optional id, and a bound client rebuilds by name", () => {
    expectTypeOf<RebuildReadModelArgs["actor"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Parameters<ReturnType<App["as"]>["rebuildReadModel"]>>().toEqualTypeOf<
      [name: string]
    >();
  });
});

describe("createConsoleLogger", () => {
  it("writes to any stream with a write method, such as process.stderr", () => {
    createConsoleLogger({ stream: stderr });
    createConsoleLogger({ level: "warn", stream: { write: (text: string) => text.length } });
    expectTypeOf<NonNullable<CreateConsoleLoggerArgs["stream"]>>().toEqualTypeOf<{
      write(text: string): unknown;
    }>();
    // @ts-expect-error a stream needs write
    createConsoleLogger({ stream: {} });
  });
});
