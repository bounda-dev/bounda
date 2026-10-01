import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../contracts/errors.ts";
import { selectCollaborators } from "./collaborators.ts";

const http = { reserve: () => Promise.resolve("http") };
const fake = { reserve: () => Promise.resolve("fake") };
const mailer = { send: () => Promise.resolve() };

describe("selectCollaborators", () => {
  it("uses the configured implementation", () => {
    const selected = selectCollaborators({
      aggregate: "order",
      implementations: { inventory: { http: { default: http }, fake: { default: fake } } },
      config: { inventory: "fake" },
    });
    expect(selected).toEqual({ inventory: fake });
  });

  it("picks the only implementation when nothing is configured", () => {
    const selected = selectCollaborators({
      aggregate: "order",
      implementations: {
        inventory: { http: { default: http } },
        mailer: { resend: { default: mailer } },
      },
      config: undefined,
    });
    expect(selected).toEqual({ inventory: http, mailer });
  });

  it("returns an empty object for an aggregate without collaborators", () => {
    expect(
      selectCollaborators({ aggregate: "order", implementations: {}, config: undefined }),
    ).toEqual({});
  });

  it("demands a choice when several implementations exist and none is configured", () => {
    expect(() =>
      selectCollaborators({
        aggregate: "order",
        implementations: { inventory: { http: { default: http }, fake: { default: fake } } },
        config: undefined,
      }),
    ).toThrow(
      'Aggregate "order", collaborator "inventory": choose an implementation with collaborators.order.inventory. Available: "http", "fake"',
    );
  });

  it("refuses a port without implementations rather than handing out nothing", () => {
    expect(() =>
      selectCollaborators({
        aggregate: "order",
        implementations: { inventory: {} },
        config: undefined,
      }),
    ).toThrow(
      'Aggregate "order", collaborator "inventory": choose an implementation with collaborators.order.inventory. Available: ',
    );
  });

  it("rejects an implementation that does not exist", () => {
    expect(() =>
      selectCollaborators({
        aggregate: "order",
        implementations: { inventory: { http: { default: http }, fake: { default: fake } } },
        config: { inventory: "grpc" },
      }),
    ).toThrow(
      'Aggregate "order", collaborator "inventory": implementation "grpc" not found. Available: "http", "fake"',
    );
  });

  it("does not take a property of Object.prototype for an implementation or a port", () => {
    const implementations = { inventory: { http: { default: http } } };
    expect(() =>
      selectCollaborators({
        aggregate: "order",
        implementations,
        config: { inventory: "constructor" },
      }),
    ).toThrow('implementation "constructor" not found');
    expect(() =>
      selectCollaborators({ aggregate: "order", implementations, config: { toString: "x" } }),
    ).toThrow('configuration names collaborators that do not exist: "toString"');
  });

  it("rejects configuration for collaborators the aggregate does not have", () => {
    let error: unknown;
    try {
      selectCollaborators({
        aggregate: "order",
        implementations: { inventory: { http: { default: http } } },
        config: { inventory: "http", notifier: "console" },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toBe(
      'Aggregate "order": configuration names collaborators that do not exist: "notifier"',
    );
  });
});
