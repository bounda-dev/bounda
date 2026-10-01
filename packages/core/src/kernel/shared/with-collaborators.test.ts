import { describe, expect, it } from "vitest";
import { withCollaborators } from "./with-collaborators.ts";

describe("withCollaborators", () => {
  it("reads a port only when the handler reads it, and lets the handler's own arguments win", () => {
    const reads: string[] = [];
    const ports = Object.defineProperties(
      {},
      {
        notifier: { enumerable: true, get: () => reads.push("notifier") },
        signal: { enumerable: true, get: () => reads.push("signal") },
      },
    );
    const args = withCollaborators(ports, { signal: "own", idempotencyKey: "k" });
    expect(reads).toEqual([]);
    const { signal, idempotencyKey } = args as typeof args & { readonly notifier: unknown };
    expect({ signal, idempotencyKey }).toEqual({ signal: "own", idempotencyKey: "k" });
    expect(reads).toEqual([]);
    expect(Reflect.get(args, "notifier")).toBe(1);
    expect(reads).toEqual(["notifier"]);
  });
});
