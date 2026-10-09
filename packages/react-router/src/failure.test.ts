import {
  ConcurrencyError,
  DomainError,
  type PayloadArgs,
  type RejectFunction,
  type Rejection,
  ValidationError,
} from "@bounda-dev/core";
import { createTestApp } from "@bounda-dev/core/testing";
import { describe, expect, it } from "vitest";
import { failure } from "./failure.ts";

const rejection = { code: "AlreadyPlaced", message: "Order o-1 was already placed" } as Rejection;

const registry = {
  aggregates: {
    order: {
      state: { initialState: {} },
      events: {},
      commands: {
        placeOrder: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
            rejections: () => ({ AlreadyPlaced: "Order already placed" }),
            handler: ({ reject }: { reject: RejectFunction<"AlreadyPlaced"> }) =>
              reject("AlreadyPlaced"),
          },
        },
        noteOrder: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
            rejections: () => ({ Closed: "Notes are closed" }),
            handler: () => {
              throw new DomainError(rejection);
            },
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
};

describe("failure", () => {
  it("answers a payload that does not validate with a 400 and its issues", () => {
    const issues = [{ path: ["email"], message: "Invalid email" }];
    const answer = failure(new ValidationError("Invalid command RegisterUser", issues));
    expect(answer.data).toEqual({ error: "Invalid command RegisterUser", issues });
    expect(answer.init).toEqual({ status: 400 });
  });

  it("answers a command's rejection with a 409 and its code", () => {
    const answer = failure(new DomainError(rejection));
    expect(answer.data).toEqual({
      error: "Order o-1 was already placed",
      issues: [],
      rejected: "AlreadyPlaced",
    });
    expect(answer.init).toEqual({ status: 409 });
  });

  it("rethrows anything else, for the route's ErrorBoundary", () => {
    const conflict = new ConcurrencyError({
      streamId: "order:o-1",
      expectedVersion: 1,
      actualVersion: 2,
    });
    expect(() => failure(conflict)).toThrow(conflict);
    const bug = new TypeError("boom");
    expect(() => failure(bug)).toThrow(bug);
  });

  it("answers only the command's own rejection, and rethrows another command's it let through", async () => {
    const { app } = await createTestApp({ registry });
    const answer = await app.commands.placeOrder({ orderId: "o-1" }).catch(failure);
    expect(answer).toMatchObject({
      data: { error: "Order already placed", rejected: "AlreadyPlaced" },
      init: { status: 409 },
    });
    const thrown = await app.commands
      .noteOrder({ orderId: "o-1" })
      .catch((error: unknown) => error);
    expect(() => failure(thrown)).toThrow(thrown as Error);
    expect(thrown).toMatchObject({ code: "FOREIGN_REJECTION" });
    await app.stop();
  });
});
