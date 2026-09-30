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
