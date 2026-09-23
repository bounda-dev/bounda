import { describe, expect, it } from "vitest";
import {
  BoundaError,
  ChainDepthExceededError,
  ConcurrencyError,
  ConfigurationError,
  DomainError,
  NotFoundError,
  RebuildSupersededError,
  ValidationError,
} from "./errors.ts";

describe("errors", () => {
  it("expose a stable code and the subclass name", () => {
    const error = new DomainError("Order already placed");
    expect(error).toBeInstanceOf(BoundaError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("DOMAIN_ERROR");
    expect(error.name).toBe("DomainError");
    expect(error.message).toBe("Order already placed");
  });

  it("preserve the cause", () => {
    const cause = new Error("socket closed");
    const error = new ConfigurationError("Adapter failed to start", { cause });
    expect(error.cause).toBe(cause);
    expect(error.code).toBe("INVALID_CONFIGURATION");
  });

  it("describe a concurrency conflict with both versions", () => {
    const error = new ConcurrencyError({
      streamId: "order:42",
      expectedVersion: 3,
      actualVersion: 4,
    });
    expect(error.code).toBe("CONCURRENCY_CONFLICT");
    expect(error.message).toBe("Stream order:42 is at version 4, expected 3");
    expect(error.expectedVersion).toBe(3);
    expect(error.actualVersion).toBe(4);
  });

  it("carry validation issues", () => {
    const error = new ValidationError("Invalid payload", [
      { path: ["total"], message: "Expected number" },
    ]);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.issues).toEqual([{ path: ["total"], message: "Expected number" }]);
  });

  it("report the depth that exceeded the chain limit", () => {
    const error = new ChainDepthExceededError(26, 25);
    expect(error.code).toBe("CHAIN_DEPTH_EXCEEDED");
    expect(error.depth).toBe(26);
    expect(error.maxDepth).toBe(25);
  });

  it("name the read model whose rebuild was taken over", () => {
    const error = new RebuildSupersededError("orderSummary");
    expect(error.code).toBe("REBUILD_SUPERSEDED");
    expect(error.readModel).toBe("orderSummary");
    expect(error.message).toContain('"orderSummary"');
  });

  it("mark missing resources", () => {
    expect(new NotFoundError("Aggregate order:1 not found").code).toBe("NOT_FOUND");
  });
});
